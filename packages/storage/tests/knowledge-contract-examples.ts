import { createHash } from 'node:crypto';

import type {
  ActFootprint,
  Actor,
  admitsProcessingJob,
  Applicability,
  ApplicabilityInputs,
  ApplicabilitySelector,
  ApplicableAssignment,
  ApprovalBinding,
  ApprovalTarget,
  Assessment,
  Assignment,
  Attribution,
  AuthorityScope,
  Authorization,
  AuthorizationContext,
  AuthorizationRecord,
  AuthorizationRefusal,
  checkAuthorization,
  ClaimRevision,
  ConflictAnswer,
  ConflictDisposition,
  CorrectionAction,
  CorrectionChangeClass,
  CorrectionRefusal,
  CriterionReference,
  DecisionRevision,
  Departure,
  EarlierConflictAnswer,
  ExpectationRevisionRef,
  ExpectedState,
  FollowedCorrection,
  GoverningState,
  KnowledgeException,
  Observation,
  PassageRestatement,
  PassageRestatementRefusal,
  RecordRevisionRef,
  Relationship,
  RelationshipTarget,
  RequirementRevision,
  ResolutionRefusal,
  RestatingSource,
  RevisionLink,
  RevisionRefusal,
  Revocation,
  Selection,
  SelectorResolution,
  SourceOccurrence,
  SourceSelector,
  TaskUse,
} from '../src/schema/knowledge-contract.js';

const id = (n: number) => `01a0b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const hash = (fill: string) => fill.repeat(64);

export const owner: Actor = { identity: 'owner@example.test', basis: 'authenticated' };
export const agent: Actor = { identity: 'claude-code', basis: 'source_attributed' };
export const reportedOwner: Actor = {
  identity: 'owner@example.test',
  basis: 'agent_reported_user_instruction',
};
export const unknownActor: Actor = { identity: null, basis: 'unknown' };

const by = (actor: Actor) => ({ kind: 'actor' as const, actor });
const processor = { kind: 'detector' as const, detector: 'knowledge-processor' };

const project: AuthorityScope = { kind: 'project', project_id: id(1) };
const retryArtifact: AuthorityScope = { kind: 'artifact', artifact_id: id(11) };

const offlineCriterion: CriterionReference = {
  artifact_id: id(10),
  plan_event_id: id(20),
  criterion_id: id(30),
};

const offlineRequirement: ExpectationRevisionRef = {
  kind: 'requirement',
  entity_id: offlineCriterion.criterion_id,
  revision_id: id(40),
};
const offlineRequirementWithSearch: ExpectationRevisionRef = {
  ...offlineRequirement,
  revision_id: id(41),
};
const storageDecision: ExpectationRevisionRef = {
  kind: 'decision',
  entity_id: id(72),
  revision_id: id(73),
};
const storageDecisionSuccessor: ExpectationRevisionRef = {
  ...storageDecision,
  revision_id: id(74),
};
const defectClaim: RecordRevisionRef = { kind: 'claim', entity_id: id(70), revision_id: id(71) };
const defectClaimCorrected: RecordRevisionRef = { ...defectClaim, revision_id: id(76) };

const observed = (selection_ids: string[], correction_action_ids: string[]): ExpectedState => ({
  kind: 'observed',
  selection_ids,
  correction_action_ids,
});

const informedAbout = (
  acknowledged: ExpectationRevisionRef[],
  scope: AuthorityScope = project
): Authorization => ({
  kind: 'informed_instruction',
  instruction_source_id: id(57),
  acknowledged,
  scope,
});

const explicitInstruction = (scope: AuthorityScope = project): Authorization => ({
  kind: 'explicit_instruction',
  instruction_source_id: id(57),
  scope,
});

const firstRevision: RequirementRevision = {
  requirement_id: offlineCriterion.criterion_id,
  revision_id: offlineRequirement.revision_id,
  previous_revision_id: null,
  statement: 'Local capture works with no Cloud connection.',
  rationale: 'Captures must never depend on network availability.',
  subject: null,
  applicability: { all_of: [] },
  duration: { kind: 'continuing' },
  source_ids: [id(50)],
  passages: [],
  source_standing: 'explicit_instruction',
  attributed_to: by(reportedOwner),
  recorded_at: '2026-09-17T09:00:00.000Z',
};

const criterionSource: SourceOccurrence = {
  source_id: id(50),
  occurrence: {
    kind: 'capture_field',
    artifact_id: offlineCriterion.artifact_id,
    event_id: offlineCriterion.plan_event_id,
    field_path: 'plan_steps[0].acceptance_criteria[0].text',
    position: 0,
  },
  source_author: reportedOwner,
  recorded_by: agent,
  interpreted_by: null,
  access_restriction: null,
};

const useByLaterTask: TaskUse = {
  artifact_id: id(11),
  plan_event_id: id(21),
  target: offlineRequirement,
  role: 'preserve',
  local: { step_id: id(31), criterion_id: null },
  exception_id: null,
  selection: { kind: 'selected_with_plan' },
};

const candidateFromProcessing: RequirementRevision = {
  ...firstRevision,
  requirement_id: id(35),
  revision_id: id(48),
  statement: 'Sync retries never block the capture screen.',
  rationale: null,
  source_standing: 'extracted_candidate',
  attributed_to: processor,
};

/**
 * "Local capture works without Cloud" first appears as a task criterion. Its
 * continuing requirement is that criterion, and a later retry task preserves it.
 */
export const canonicalCriterionReuse = {
  identity: {
    requirement_id: offlineCriterion.criterion_id,
    origin: { kind: 'promoted_criterion', criterion: offlineCriterion },
  },
  firstRevision,
  candidateFromProcessing,
  source: criterionSource,
  useByLaterTask,
  connectionFoundAfterTheTask: {
    ...useByLaterTask,
    artifact_id: id(12),
    plan_event_id: id(22),
    role: 'background',
    local: null,
    selection: {
      kind: 'connected_later',
      discovered_at: '2026-09-18T10:00:00.000Z',
      discovered_by: processor,
    },
  } satisfies TaskUse,
  whoWroteTheUse: {
    thePlanEventsOwnOperation: {
      plan_event_operation_id: id(200),
      writing_operation_id: id(200),
      discovery: null,
    },
    aLaterOperationThatSaysNothingOfDiscovery: {
      plan_event_operation_id: id(200),
      writing_operation_id: id(201),
      discovery: null,
    },
  },
  refused: {
    competingCopyUnderNewIdentity: {
      requirement_id: id(99),
      origin: { kind: 'promoted_criterion', criterion: offlineCriterion },
    },
    laterConnectionPresentedWithoutDiscovery: {
      ...useByLaterTask,
      selection: { kind: 'connected_later' },
    },
    sourceThatIsOnlyAMutableUrl: {
      ...criterionSource,
      source_id: id(51),
      occurrence: {
        kind: 'external_reference',
        retention: { kind: 'retained_reference', reference: 'https://example.test/spec' },
        location: null,
        source_time: null,
      },
    },
    namedActorWithUnknownBasis: { identity: 'owner@example.test', basis: 'unknown' },
    blankActorIdentity: { identity: ' ', basis: 'authenticated' },
    recordIdContainingWhitespace: { ...offlineCriterion, criterion_id: 'a b' },
    derivedRevisionPresentedAsAnInstruction: {
      ...candidateFromProcessing,
      source_standing: 'explicit_instruction',
    },
    detectorNamedAsTheInterpretingActor: {
      ...criterionSource,
      source_id: id(60),
      interpreted_by: { identity: 'knowledge-processor', basis: 'other_assertion' },
    },
    detectorNamedAsTheDiscoveringActor: {
      ...useByLaterTask,
      selection: {
        kind: 'connected_later',
        discovered_at: '2026-09-18T10:00:00.000Z',
        discovered_by: { identity: 'knowledge-processor', basis: 'other_assertion' },
      },
    },
  },
  /** Nobody interpreted it, and a detector did: two facts, never the same one. */
  interpretation: {
    nobody: criterionSource,
    aDetector: { ...criterionSource, source_id: id(61), interpreted_by: processor },
    anActor: { ...criterionSource, source_id: id(62), interpreted_by: by(agent) },
  },
};

const derivedFromRegressionTest = {
  kind: 'derived',
  derived_from: {
    kind: 'criterion',
    criterion: { artifact_id: id(10), plan_event_id: id(20), criterion_id: id(33) },
  },
  explanation:
    'The regression test exists to protect offline availability; the availability itself is the lasting obligation.',
  source_id: id(52),
  derived_at: '2026-09-17T09:30:00.000Z',
};

/** "Add a regression test" is one obligation; "remain available offline" is another. */
export const distinctDerivedObligation = {
  identity: { requirement_id: id(32), origin: derivedFromRegressionTest },
  refused: {
    derivedObligationSharingItsSourceIdentity: {
      requirement_id: id(33),
      origin: derivedFromRegressionTest,
    },
  },
};

const root: RevisionLink = { revision_id: id(40), previous_revision_id: null };
const tighterLimit: RevisionLink = { revision_id: id(41), previous_revision_id: id(40) };
const looserLimit: RevisionLink = { revision_id: id(42), previous_revision_id: id(40) };

const refusedRevision = (next: RevisionLink, code: RevisionRefusal) => ({ next, code });

/** Two tasks each propose a successor of the same adopted revision. Both stand. */
export const siblingRevisions = {
  lineage: [root, tighterLimit],
  secondSuccessorOfTheSameRevision: looserLimit,
  tipsAfterBoth: [tighterLimit.revision_id, looserLimit.revision_id],
  refused: {
    predecessorFromAnotherIdentity: refusedRevision(
      { revision_id: id(43), previous_revision_id: id(900) },
      'PREDECESSOR_NOT_IN_LINEAGE'
    ),
    secondRoot: refusedRevision(
      { revision_id: id(44), previous_revision_id: null },
      'LINEAGE_ALREADY_ROOTED'
    ),
    reusedRevisionId: refusedRevision(
      { revision_id: id(41), previous_revision_id: id(40) },
      'REVISION_ID_REUSED'
    ),
  },
};

const defectPassage: SourceSelector = {
  source_id: id(63),
  location: 'checkpoint 3 / findings[0]',
  passage_sha256: hash('7'),
};

const duplicateUploadFinding: ClaimRevision = {
  claim_id: defectClaim.entity_id,
  revision_id: defectClaim.revision_id,
  previous_revision_id: null,
  statement: 'Retrying an upload after a gateway error uploads the file twice.',
  subject: null,
  applicability: { all_of: [] },
  source_ids: [defectPassage.source_id],
  passages: [defectPassage],
  source_standing: 'agent_proposal',
  attributed_to: by(agent),
  observation_ids: [id(156)],
  verification: {
    provenance: 'agent_reported',
    account: 'Ran the upload smoke against the staging gateway twice and saw two stored objects.',
    reported_by: agent,
  },
  recorded_at: '2026-09-17T11:30:00.000Z',
};

const findingExtractedByProcessing: ClaimRevision = {
  ...duplicateUploadFinding,
  claim_id: id(150),
  revision_id: id(151),
  source_standing: 'extracted_candidate',
  attributed_to: processor,
  verification: null,
};

/**
 * A finding is evidence, never a desired behavior. What it states and what
 * anybody reported about checking it stay apart, and what a detector extracts
 * is a candidate it has verified nothing about.
 */
export const findingsAsClaims = {
  duplicateUploadFinding,
  findingExtractedByProcessing,
  /** A finding somebody simply wrote down observed nothing, and says so. */
  findingNobodyObserved: {
    ...duplicateUploadFinding,
    claim_id: id(157),
    revision_id: id(158),
    observation_ids: [],
    verification: null,
  },
  correctedAccountOfTheSameFinding: {
    revision_id: defectClaimCorrected.revision_id,
    previous_revision_id: defectClaim.revision_id,
  } satisfies RevisionLink,
  lineage: [
    { revision_id: defectClaim.revision_id, previous_revision_id: null },
  ] satisfies RevisionLink[],
  refused: {
    'a finding a detector says it verified': {
      revision: {
        ...findingExtractedByProcessing,
        verification: duplicateUploadFinding.verification,
      },
      paths: ['verification'],
    },
    'a finding a detector presents as an instruction': {
      revision: { ...findingExtractedByProcessing, source_standing: 'explicit_instruction' },
      paths: ['source_standing'],
    },
    'a finding at no exact passage': {
      revision: { ...duplicateUploadFinding, passages: [] },
      paths: ['passages'],
    },
  },
};

const retryIdempotencyDecision: DecisionRevision = {
  decision_id: id(152),
  revision_id: id(153),
  previous_revision_id: null,
  chosen_approach: 'Retry uploads under an idempotency key rather than lengthening the backoff.',
  rationale: 'The duplicate comes from the retry itself, not from its timing.',
  alternatives: [
    { option: 'A longer backoff', rejected_because: 'A slower duplicate is still a duplicate.' },
  ],
  assumptions: [],
  reconsideration_conditions: [],
  subject: null,
  applicability: { all_of: [] },
  source_ids: [id(57)],
  passages: [{ source_id: id(57), location: 'message 2', passage_sha256: hash('8') }],
  source_standing: 'explicit_instruction',
  attributed_to: by(reportedOwner),
  derivation: {
    derived_from: storageDecision,
    explanation:
      'The storage decision fixed where retried bytes land; this one fixes how a retry is identified.',
    source_id: id(57),
    derived_at: '2026-09-18T09:00:00.000Z',
  },
  recorded_at: '2026-09-18T09:00:00.000Z',
};

/**
 * A decision's identity record carries nothing, so where a derived decision
 * came from lives on the revision that mints it — and never lets it take the
 * identity it came from, exactly as a requirement's origin does not.
 */
export const derivedDecision = {
  retryIdempotencyDecision,
  decisionThatCameFromNoRule: {
    ...retryIdempotencyDecision,
    revision_id: id(154),
    derivation: null,
  },
  refused: {
    'a derived decision sharing the identity it came from': {
      revision: { ...retryIdempotencyDecision, decision_id: storageDecision.entity_id },
      paths: ['decision_id'],
    },
    'an ancestry named on a later revision': {
      revision: {
        ...retryIdempotencyDecision,
        revision_id: id(155),
        previous_revision_id: retryIdempotencyDecision.revision_id,
      },
      paths: ['derivation'],
    },
    'a decision at no exact passage': {
      revision: { ...retryIdempotencyDecision, passages: [] },
      paths: ['passages'],
    },
  },
};

const proposalBase = {
  scope: project,
  attributed_to: by(agent),
  source_id: id(53),
  authorization: null,
  expected_state: observed([id(60)], []),
};

const replacementOfTheStorageDecision: CorrectionAction = {
  ...proposalBase,
  action_id: id(81),
  kind: 'accepted_replacement',
  targets: [storageDecision],
  replacement: storageDecisionSuccessor,
  designation: 'adopted',
  attributed_to: by(reportedOwner),
  authorization: informedAbout([storageDecision]),
};

const reversalNamingItsResult: CorrectionAction = {
  ...proposalBase,
  action_id: id(82),
  kind: 'reversal',
  targets: [storageDecisionSuccessor],
  reverses_action_id: replacementOfTheStorageDecision.action_id,
  resulting_selection: { kind: 'revision', revision: storageDecision, designation: 'adopted' },
  attributed_to: by(reportedOwner),
  authorization: informedAbout([storageDecisionSuccessor, storageDecision]),
  expected_state: observed([id(60)], [replacementOfTheStorageDecision.action_id]),
};

const challengeToTheRequirement: CorrectionAction = {
  ...proposalBase,
  action_id: id(86),
  kind: 'challenge',
  targets: [offlineRequirement],
  explanation: 'Offline capture may be unaffordable on the smallest devices.',
};

const acceptedChallengeToTheRequirement: CorrectionAction = {
  ...proposalBase,
  action_id: id(93),
  kind: 'acceptance',
  targets: [offlineRequirement],
  accepts_action_id: challengeToTheRequirement.action_id,
  attributed_to: by(reportedOwner),
  authorization: informedAbout([offlineRequirement]),
};

const correctedAccountOfAFinding: CorrectionAction = {
  ...proposalBase,
  action_id: id(79),
  kind: 'factual_correction',
  targets: [defectClaim],
  corrected_account: 'The defect was observed on the previous build, not this one.',
};

const withdrawalOfAFinding: CorrectionAction = {
  ...proposalBase,
  action_id: id(85),
  kind: 'withdrawal',
  targets: [defectClaim],
  scope: retryArtifact,
  reason: 'The finding was recorded against the wrong build and is withdrawn.',
};

const replacementRelationship: RecordRevisionRef = {
  kind: 'relationship',
  entity_id: id(110),
  revision_id: id(110),
};

const decisionRevisionRef = (revision_id: string): ExpectationRevisionRef => ({
  ...storageDecision,
  revision_id,
});

const follows = (action: CorrectionAction, followed: FollowedCorrection | null = null) => ({
  action,
  followed,
});

interface CorrectionCase {
  action: CorrectionAction;
  followed: FollowedCorrection | null;
  standing_followers?: string[];
  relationship_targets?: RelationshipTarget[];
  adopted_beside?: ExpectationRevisionRef[];
  findings_originate_in_scope?: boolean;
}

const knownRelationship = (standing: RelationshipTarget['standing']): RelationshipTarget => ({
  relationship_id: replacementRelationship.entity_id,
  standing,
  relation: 'supersedes',
  from: storageDecisionSuccessor,
  to: storageDecision,
  attributed_to: by(reportedOwner),
});

const dependencyRelationship: RecordRevisionRef = {
  kind: 'relationship',
  entity_id: id(112),
  revision_id: id(112),
};

const dependencyEstablishedByTheAgent: RelationshipTarget = {
  relationship_id: dependencyRelationship.entity_id,
  standing: 'established',
  relation: 'depends_on',
  from: offlineRequirement,
  to: storageDecision,
  attributed_to: by(agent),
};

const ownersWithdrawalOfTheReplacement: CorrectionAction = {
  ...proposalBase,
  action_id: id(88),
  kind: 'withdrawal',
  targets: [replacementRelationship],
  attributed_to: by(reportedOwner),
  authorization: informedAbout([storageDecisionSuccessor]),
  reason: 'The successor was recorded against the wrong decision.',
};

const retractionOfTheChallenge: CorrectionAction = {
  ...proposalBase,
  action_id: id(107),
  kind: 'reversal',
  targets: [offlineRequirement],
  reverses_action_id: challengeToTheRequirement.action_id,
  resulting_selection: { kind: 'none' },
};

const ownersWithdrawalOfTheRequirement: CorrectionAction = {
  ...proposalBase,
  action_id: id(87),
  kind: 'withdrawal',
  targets: [offlineRequirement],
  attributed_to: by(reportedOwner),
  authorization: informedAbout([offlineRequirement]),
  reason: 'Offline capture is no longer a product promise.',
};

const ownersReversalLeavingNothingSelected: CorrectionAction = {
  ...reversalNamingItsResult,
  action_id: id(83),
  resulting_selection: { kind: 'none' },
};

const reversalOf = (
  followedAction: CorrectionAction,
  targets: RecordRevisionRef[],
  change: Partial<Extract<CorrectionAction, { kind: 'reversal' }>> = {}
): CorrectionAction => ({
  ...proposalBase,
  action_id: id(84),
  kind: 'reversal',
  targets,
  reverses_action_id: followedAction.action_id,
  resulting_selection: { kind: 'none' },
  ...change,
});

const accepted = (
  correction: CorrectionCase,
  changeClass: CorrectionChangeClass,
  footprint: { adopts?: number; departs?: Departure['how'][]; restates?: number }
) => ({ ...correction, changeClass, footprint });

const refusedCorrection = (correction: CorrectionCase, code: CorrectionRefusal) => ({
  ...correction,
  code,
});

/**
 * A finding is challenged, corrected and withdrawn by whoever works in its
 * artifact; a decision is replaced and the replacement later reversed by
 * someone with authority over it. Every action is appended, a reversal or an
 * acceptance is judged with the action it follows, and the change class
 * follows from what the action does.
 */
export const correctionAndReversal = {
  accepted: {
    'a challenge to a finding': accepted(
      {
        action: {
          ...proposalBase,
          action_id: id(80),
          kind: 'challenge',
          targets: [defectClaim],
          explanation: 'The reported defect was observed against a different build.',
        },
        followed: null,
      },
      'factual_correction',
      {}
    ),
    'a challenge a detector proposes': accepted(
      {
        action: {
          ...proposalBase,
          action_id: id(89),
          kind: 'challenge',
          targets: [offlineRequirement],
          attributed_to: processor,
          explanation: 'A later summary describes a Cloud-only startup path.',
        },
        followed: null,
      },
      'proposal',
      {}
    ),
    'a challenge to a requirement, which changes nothing that stands': accepted(
      { action: challengeToTheRequirement, followed: null },
      'proposal',
      {}
    ),
    'a correction of how a task used a requirement': accepted(
      {
        action: {
          ...proposalBase,
          action_id: id(90),
          kind: 'use_correction',
          targets: [offlineRequirement],
          mistaken_use: { artifact_id: id(12), plan_event_id: id(22), target: offlineRequirement },
          intended_interpretation: 'The export task never relied on offline capture.',
        },
        followed: null,
      },
      'proposal',
      {}
    ),
    'a correction of the account a requirement was recorded with': accepted(
      {
        action: {
          ...proposalBase,
          action_id: id(91),
          kind: 'factual_correction',
          targets: [offlineRequirement],
          corrected_account: 'The instruction came from the support lead, not the owner.',
        },
        followed: null,
      },
      'factual_correction',
      {}
    ),
    'a withdrawal of a finding from its own artifact, with no authority': accepted(
      { action: withdrawalOfAFinding, followed: null, findings_originate_in_scope: true },
      'factual_correction',
      { restates: 1 }
    ),
    'a corrected finding replacing the original in its own artifact': accepted(
      {
        action: {
          ...proposalBase,
          action_id: id(92),
          kind: 'accepted_replacement',
          targets: [defectClaim],
          replacement: defectClaimCorrected,
          designation: 'adopted',
          scope: retryArtifact,
        },
        followed: null,
        findings_originate_in_scope: true,
      },
      'factual_correction',
      { adopts: 1, restates: 1 }
    ),
    'a finding that belongs to no artifact withdrawn on a project instruction': accepted(
      {
        action: {
          ...withdrawalOfAFinding,
          scope: project,
          attributed_to: by(reportedOwner),
          authorization: explicitInstruction(),
        },
        followed: null,
        findings_originate_in_scope: false,
      },
      'factual_correction',
      { restates: 1 }
    ),
    'an accepted correction to a finding on a project instruction': accepted(
      {
        action: {
          ...proposalBase,
          action_id: id(78),
          kind: 'acceptance',
          targets: [defectClaim],
          accepts_action_id: correctedAccountOfAFinding.action_id,
          attributed_to: by(reportedOwner),
          authorization: explicitInstruction(),
        },
        followed: follows(correctedAccountOfAFinding),
      },
      'factual_correction',
      { restates: 1 }
    ),
    'a wrongly suggested relationship withdrawn by anyone': accepted(
      {
        action: { ...withdrawalOfAFinding, targets: [replacementRelationship], scope: project },
        followed: null,
        relationship_targets: [knownRelationship('suggested')],
      },
      'factual_correction',
      {}
    ),
    'an established replacement withdrawn by someone who acknowledged what it put in place':
      accepted(
        {
          action: {
            ...withdrawalOfAFinding,
            targets: [replacementRelationship],
            scope: project,
            attributed_to: by(reportedOwner),
            authorization: informedAbout([storageDecisionSuccessor]),
          },
          followed: null,
          relationship_targets: [knownRelationship('established')],
        },
        'intent_change',
        { departs: ['withdraws'], restates: 1 }
      ),
    'a withdrawn requirement restored by someone who acknowledged it': accepted(
      {
        action: reversalOf(ownersWithdrawalOfTheRequirement, [offlineRequirement], {
          resulting_selection: {
            kind: 'revision',
            revision: offlineRequirement,
            designation: 'adopted',
          },
          attributed_to: by(reportedOwner),
          authorization: informedAbout([offlineRequirement]),
        }),
        followed: follows(ownersWithdrawalOfTheRequirement),
      },
      'intent_change',
      { adopts: 1, departs: ['corrects'] }
    ),
    'a challenge retracted by whoever made it': accepted(
      {
        action: reversalOf(challengeToTheRequirement, [offlineRequirement]),
        followed: follows(challengeToTheRequirement),
      },
      'factual_correction',
      {}
    ),
    'a dependency withdrawn by whoever established it': accepted(
      {
        action: { ...withdrawalOfAFinding, targets: [dependencyRelationship], scope: project },
        followed: null,
        relationship_targets: [dependencyEstablishedByTheAgent],
      },
      'intent_change',
      { restates: 1 }
    ),
    'a withdrawn replacement put back by someone who acknowledged what it replaces': accepted(
      {
        action: reversalOf(ownersWithdrawalOfTheReplacement, [replacementRelationship], {
          attributed_to: by(reportedOwner),
          authorization: informedAbout([storageDecision]),
        }),
        followed: follows(ownersWithdrawalOfTheReplacement),
        relationship_targets: [knownRelationship('established')],
      },
      'intent_change',
      { departs: ['replaces'], restates: 1 }
    ),
    "someone else's challenge retracted on an instruction in scope": accepted(
      {
        action: reversalOf(challengeToTheRequirement, [offlineRequirement], {
          attributed_to: by(reportedOwner),
          authorization: explicitInstruction(),
        }),
        followed: follows(challengeToTheRequirement),
      },
      'factual_correction',
      {}
    ),
    'a replacement beside another adopted revision that the instruction also acknowledges':
      accepted(
        {
          action: {
            ...replacementOfTheStorageDecision,
            authorization: informedAbout([storageDecision, decisionRevisionRef(id(75))]),
          },
          followed: null,
          adopted_beside: [decisionRevisionRef(id(75))],
        },
        'intent_change',
        { adopts: 1, departs: ['replaces', 'stands_beside'] }
      ),
    'a replacement of a decision by someone who acknowledged it': accepted(
      { action: replacementOfTheStorageDecision, followed: null },
      'intent_change',
      { adopts: 1, departs: ['replaces'] }
    ),
    'a reversal judged on the replacement it undoes': accepted(
      { action: reversalNamingItsResult, followed: follows(replacementOfTheStorageDecision) },
      'intent_change',
      { adopts: 1, departs: ['replaces', 'corrects'] }
    ),
    'an accepted challenge to a requirement': accepted(
      {
        action: acceptedChallengeToTheRequirement,
        followed: follows(challengeToTheRequirement),
      },
      'intent_change',
      { departs: ['corrects'] }
    ),
  },
  refusedByTheStore: {
    "a reversal of the owner's replacement that names a finding and restores nothing":
      refusedCorrection(
        {
          action: {
            ...reversalNamingItsResult,
            targets: [defectClaim],
            resulting_selection: { kind: 'none' },
            scope: retryArtifact,
            attributed_to: by(agent),
            authorization: null,
          },
          followed: follows(replacementOfTheStorageDecision),
          findings_originate_in_scope: true,
        },
        'TARGETS_DIFFER_FROM_FOLLOWED'
      ),
    'a reversal of a replacement with no authorization': refusedCorrection(
      {
        action: { ...reversalNamingItsResult, authorization: null },
        followed: follows(replacementOfTheStorageDecision),
      },
      'AUTHORIZATION_REQUIRED'
    ),
    'a reversal whose instruction never acknowledged what it undoes': refusedCorrection(
      {
        action: { ...reversalNamingItsResult, authorization: informedAbout([storageDecision]) },
        followed: follows(replacementOfTheStorageDecision),
      },
      'RULE_NOT_ACKNOWLEDGED'
    ),
    'a reversal given without the action it follows': refusedCorrection(
      { action: reversalNamingItsResult, followed: null },
      'FOLLOWED_ACTION_REQUIRED'
    ),
    'a reversal given a different action than the one it names': refusedCorrection(
      { action: reversalNamingItsResult, followed: follows(challengeToTheRequirement) },
      'FOLLOWED_ACTION_MISMATCH'
    ),
    'a second reversal of an action already reversed': refusedCorrection(
      {
        action: reversalNamingItsResult,
        followed: follows(replacementOfTheStorageDecision),
        standing_followers: [id(200)],
      },
      'FOLLOWED_ACTION_ALREADY_FOLLOWED'
    ),
    "a reversal of the owner's withdrawal that restores nothing and carries no authority":
      refusedCorrection(
        {
          action: reversalOf(ownersWithdrawalOfTheRequirement, [offlineRequirement]),
          followed: follows(ownersWithdrawalOfTheRequirement),
        },
        'AUTHORIZATION_REQUIRED'
      ),
    "a reversal of the owner's reversal, which would let the replacement stand again":
      refusedCorrection(
        {
          action: reversalOf(ownersReversalLeavingNothingSelected, [storageDecisionSuccessor]),
          followed: follows(
            ownersReversalLeavingNothingSelected,
            follows(replacementOfTheStorageDecision)
          ),
        },
        'AUTHORIZATION_REQUIRED'
      ),
    "someone else's challenge retracted with no instruction": refusedCorrection(
      {
        action: reversalOf(challengeToTheRequirement, [offlineRequirement], {
          attributed_to: by(reportedOwner),
        }),
        followed: follows(challengeToTheRequirement),
      },
      'REVERSES_ANOTHERS_ACT'
    ),
    "someone else's retraction undone with no instruction": refusedCorrection(
      {
        action: reversalOf(retractionOfTheChallenge, [offlineRequirement], {
          action_id: id(108),
          attributed_to: by(reportedOwner),
        }),
        followed: follows(retractionOfTheChallenge, follows(challengeToTheRequirement)),
      },
      'REVERSES_ANOTHERS_ACT'
    ),
    "an unknown actor retracting an unknown actor's challenge": refusedCorrection(
      {
        action: reversalOf(
          { ...challengeToTheRequirement, attributed_to: by(unknownActor) },
          [offlineRequirement],
          { attributed_to: by(unknownActor) }
        ),
        followed: follows({ ...challengeToTheRequirement, attributed_to: by(unknownActor) }),
      },
      'REVERSES_ANOTHERS_ACT'
    ),
    "a retraction recorded under the challenger's name on someone else's word": refusedCorrection(
      {
        action: reversalOf(challengeToTheRequirement, [offlineRequirement], {
          attributed_to: by({ identity: agent.identity, basis: 'other_assertion' }),
        }),
        followed: follows(challengeToTheRequirement),
      },
      'REVERSES_ANOTHERS_ACT'
    ),
    'a reversal that restores a revision the replacement never departed from': refusedCorrection(
      {
        action: {
          ...reversalNamingItsResult,
          resulting_selection: {
            kind: 'revision',
            revision: decisionRevisionRef(id(75)),
            designation: 'adopted',
          },
          authorization: informedAbout([
            storageDecisionSuccessor,
            storageDecision,
            decisionRevisionRef(id(75)),
          ]),
        },
        followed: follows(replacementOfTheStorageDecision),
      },
      'RESTORES_WHAT_WAS_NOT_DEPARTED_FROM'
    ),
    'a dependency withdrawn by someone other than whoever established it': refusedCorrection(
      {
        action: {
          ...withdrawalOfAFinding,
          targets: [dependencyRelationship],
          scope: project,
          attributed_to: by(reportedOwner),
        },
        followed: null,
        relationship_targets: [dependencyEstablishedByTheAgent],
      },
      'AUTHORIZATION_REQUIRED'
    ),
    'a withdrawn replacement put back by someone who acknowledged only the successor':
      refusedCorrection(
        {
          action: reversalOf(ownersWithdrawalOfTheReplacement, [replacementRelationship], {
            attributed_to: by(reportedOwner),
            authorization: informedAbout([storageDecisionSuccessor]),
          }),
          followed: follows(ownersWithdrawalOfTheReplacement),
          relationship_targets: [knownRelationship('established')],
        },
        'RULE_NOT_ACKNOWLEDGED'
      ),
    'a replacement beside another adopted revision the instruction never acknowledged':
      refusedCorrection(
        {
          action: replacementOfTheStorageDecision,
          followed: null,
          adopted_beside: [decisionRevisionRef(id(75))],
        },
        'RULE_NOT_ACKNOWLEDGED'
      ),
    'a withdrawal of a relationship the store knows nothing about': refusedCorrection(
      {
        action: { ...withdrawalOfAFinding, targets: [replacementRelationship], scope: project },
        followed: null,
      },
      'RELATIONSHIP_TARGET_UNKNOWN'
    ),
    'an established replacement withdrawn on an instruction that acknowledges nothing':
      refusedCorrection(
        {
          action: {
            ...withdrawalOfAFinding,
            targets: [replacementRelationship],
            scope: project,
            attributed_to: by(reportedOwner),
            authorization: explicitInstruction(),
          },
          followed: null,
          relationship_targets: [knownRelationship('established')],
        },
        'RULE_NOT_ACKNOWLEDGED'
      ),
    "another artifact's finding withdrawn on an instruction scoped to this artifact":
      refusedCorrection(
        {
          action: {
            ...withdrawalOfAFinding,
            attributed_to: by(reportedOwner),
            authorization: explicitInstruction(retryArtifact),
          },
          followed: null,
          findings_originate_in_scope: false,
        },
        'FINDING_OUTSIDE_ITS_ARTIFACT'
      ),
    'an acceptance of a challenge to a requirement that names a finding': refusedCorrection(
      {
        action: {
          ...acceptedChallengeToTheRequirement,
          targets: [defectClaim],
          scope: retryArtifact,
          attributed_to: by(agent),
          authorization: null,
        },
        followed: follows(challengeToTheRequirement),
        findings_originate_in_scope: true,
      },
      'TARGETS_DIFFER_FROM_FOLLOWED'
    ),
    'an acceptance of a challenge to a requirement with no authorization': refusedCorrection(
      {
        action: { ...acceptedChallengeToTheRequirement, authorization: null },
        followed: follows(challengeToTheRequirement),
      },
      'AUTHORIZATION_REQUIRED'
    ),
    'an acceptance of something that was never a proposal': refusedCorrection(
      {
        action: {
          ...acceptedChallengeToTheRequirement,
          targets: [storageDecision],
          accepts_action_id: replacementOfTheStorageDecision.action_id,
          authorization: informedAbout([storageDecision]),
        },
        followed: follows(replacementOfTheStorageDecision),
      },
      'ACCEPTS_NON_PROPOSAL'
    ),
    'a replacement of a decision with no authorization': refusedCorrection(
      { action: { ...replacementOfTheStorageDecision, authorization: null }, followed: null },
      'AUTHORIZATION_REQUIRED'
    ),
    'a withdrawal of a requirement with no authorization': refusedCorrection(
      {
        action: { ...withdrawalOfAFinding, targets: [offlineRequirement], scope: project },
        followed: null,
      },
      'AUTHORIZATION_REQUIRED'
    ),
    'a withdrawal of an established replacement with no authorization': refusedCorrection(
      {
        action: { ...withdrawalOfAFinding, targets: [replacementRelationship], scope: project },
        followed: null,
        relationship_targets: [knownRelationship('established')],
      },
      'AUTHORIZATION_REQUIRED'
    ),
    'a withdrawal of a finding project wide with no authorization': refusedCorrection(
      {
        action: { ...withdrawalOfAFinding, scope: project },
        followed: null,
        findings_originate_in_scope: true,
      },
      'FINDING_OUTSIDE_ITS_ARTIFACT'
    ),
    'a withdrawal of a finding from an artifact it does not originate in': refusedCorrection(
      { action: withdrawalOfAFinding, followed: null, findings_originate_in_scope: false },
      'FINDING_OUTSIDE_ITS_ARTIFACT'
    ),
  },
  staleWrite: {
    expected: observed([id(60)], []),
    current: { selection_ids: [id(60)], correction_action_ids: [id(81)] } as GoverningState,
  },
  creation: {
    expected: { kind: 'initial' } as ExpectedState,
    nothingGovernsYet: { selection_ids: [], correction_action_ids: [] } as GoverningState,
    somethingAlreadyGoverns: {
      selection_ids: [id(60)],
      correction_action_ids: [],
    } as GoverningState,
  },
  refused: {
    'a reversal that would silently restore an earlier choice': {
      action: (({ resulting_selection: _restored, ...silent }) => silent)(
        reversalNamingItsResult as Extract<CorrectionAction, { kind: 'reversal' }>
      ),
      paths: ['resulting_selection'],
    },
    'a reversal of itself': {
      action: { ...reversalNamingItsResult, reverses_action_id: reversalNamingItsResult.action_id },
      paths: ['action_id'],
    },
    'a replacement that names a finding and adopts a requirement': {
      action: {
        ...replacementOfTheStorageDecision,
        targets: [defectClaim],
        replacement: offlineRequirementWithSearch,
      },
      paths: ['targets'],
    },
    'a replacement of a decision by itself': {
      action: { ...replacementOfTheStorageDecision, replacement: storageDecision },
      paths: ['targets'],
    },
    'a replacement of a requirement by a decision': {
      action: {
        ...replacementOfTheStorageDecision,
        targets: [offlineRequirement],
        authorization: informedAbout([offlineRequirement]),
      },
      paths: ['targets'],
    },
    'a withdrawal attributed to a detector': {
      action: { ...withdrawalOfAFinding, attributed_to: processor },
      paths: ['attributed_to'],
    },
    'a proposal that carries an authorization': {
      action: { ...challengeToTheRequirement, authorization: informedAbout([offlineRequirement]) },
      paths: ['authorization'],
    },
  },
  refusedStates: {
    observedStateNamingARecordTwice: {
      kind: 'observed',
      selection_ids: [id(60), id(60)],
      correction_action_ids: [],
    },
  },
};

const planApproval = {
  source_plan_ref: 'cloud:example-plan',
  version: '2',
  plan_content_sha256: hash('a'),
};

const offlinePassage: SourceSelector = {
  source_id: id(55),
  location: 'section 3',
  passage_sha256: hash('b'),
};
const anotherPassageOfTheSameSource: SourceSelector = {
  ...offlinePassage,
  location: 'section 7',
  passage_sha256: hash('d'),
};

const offlinePassageAsBackground: ApprovalTarget = {
  target: { kind: 'source_selector', selector: offlinePassage },
  scope: retryArtifact,
  designation: 'background',
};

const offlineRequirementAdopted: ApprovalTarget = {
  target: { kind: 'revision', revision: offlineRequirement },
  scope: project,
  designation: 'adopted',
};

const boundApproval: ApprovalBinding = {
  binding_id: id(90),
  approval: planApproval,
  targets: [offlineRequirementAdopted, offlinePassageAsBackground],
  departures: [],
  approved_by: owner,
  authorization_evidence_source_id: id(56),
};

const departure = (
  rule: ExpectationRevisionRef,
  how: Departure['how'],
  named: { exception_id?: string; replaced_by?: RecordRevisionRef } = {}
): Departure => ({
  rule,
  how,
  exception_id: named.exception_id ?? null,
  replaced_by: named.replaced_by ?? null,
});

const rebound = (
  binding_id: string,
  change: Partial<Pick<ApprovalBinding, 'targets' | 'departures' | 'approval'>>
): ApprovalBinding => ({ ...boundApproval, binding_id, ...change });

/** The approver was shown that the successor replaces the first revision. */
const approvalOfTheSuccessor = rebound(id(101), {
  targets: [
    {
      ...offlineRequirementAdopted,
      target: { kind: 'revision', revision: offlineRequirementWithSearch },
    },
  ],
  departures: [
    {
      departure: departure(offlineRequirement, 'replaces', {
        replaced_by: offlineRequirementWithSearch,
      }),
      scope: project,
    },
  ],
});

const resolvedPassage = (
  scope: AuthorityScope,
  designation: SelectorResolution['designation'],
  entity_id = id(34),
  binding_id = boundApproval.binding_id
): SelectorResolution => ({
  binding_id,
  selector: offlinePassage,
  resolved: { kind: 'requirement', entity_id, revision_id: id(46) },
  scope,
  designation,
});

const restating = (passage: SourceSelector, statement_sha256 = passage.passage_sha256) => ({
  passages: [passage],
  statement_sha256,
});

const refusedResolution = (
  resolution: SelectorResolution,
  resolved_revision: ReturnType<typeof restating>,
  existing: SelectorResolution[],
  code: ResolutionRefusal
) => ({ resolution, resolved_revision, existing, code });

/**
 * Approval binds exact targets, scope and designation. Identical plan text with
 * a changed binding inherits nothing, and a plan approved with no targets
 * adopts nothing.
 */
export const exactApprovalBinding = {
  planApprovedWithNoTargets: rebound(id(91), { targets: [] }),
  boundApproval,
  approvalOfTheSuccessor,
  samePlanTextWithTheSameBinding: rebound(id(93), {
    targets: [...boundApproval.targets].reverse(),
  }),
  changedBindings: {
    'a changed revision': rebound(id(92), {
      targets: [approvalOfTheSuccessor.targets[0] as ApprovalTarget, offlinePassageAsBackground],
    }),
    'a changed scope': rebound(id(94), {
      targets: [{ ...offlineRequirementAdopted, scope: retryArtifact }, offlinePassageAsBackground],
    }),
    'a changed designation': rebound(id(95), {
      targets: [
        { ...offlineRequirementAdopted, designation: 'background' },
        offlinePassageAsBackground,
      ],
    }),
    'a departure the approver was newly shown': rebound(id(98), {
      departures: [
        {
          departure: departure(storageDecision, 'replaces', {
            replaced_by: storageDecisionSuccessor,
          }),
          scope: project,
        },
      ],
    }),
    'another version of the plan': rebound(id(96), {
      approval: { ...planApproval, version: '3' },
    }),
  },
  selectorResolvedLocally: {
    resolution: resolvedPassage(retryArtifact, 'background'),
    resolved_revision: restating(offlinePassage),
    existing: [resolvedPassage(retryArtifact, 'background')],
  },
  refusedResolutions: {
    'a broadened scope': refusedResolution(
      resolvedPassage(project, 'background'),
      restating(offlinePassage),
      [],
      'SELECTOR_NOT_BOUND'
    ),
    'background upgraded to adopted': refusedResolution(
      resolvedPassage(retryArtifact, 'adopted'),
      restating(offlinePassage),
      [],
      'SELECTOR_NOT_BOUND'
    ),
    'a revision promoted from another passage of the same source': refusedResolution(
      resolvedPassage(retryArtifact, 'background'),
      restating(anotherPassageOfTheSameSource),
      [],
      'RESOLVED_REVISION_NOT_FROM_PASSAGE'
    ),
    'a revision that paraphrases the approved passage': refusedResolution(
      resolvedPassage(retryArtifact, 'background'),
      restating(offlinePassage, hash('e')),
      [],
      'RESOLVED_STATEMENT_NOT_VERBATIM'
    ),
    'a second identity for a passage another approval already resolved': refusedResolution(
      resolvedPassage(retryArtifact, 'background', id(36)),
      restating(offlinePassage),
      [resolvedPassage(project, 'adopted', id(34), id(77))],
      'SELECTOR_ALREADY_RESOLVED'
    ),
  },
  refused: {
    branchAsAnAuthorityScope: { kind: 'branch', branch: 'feature/retry' },
    oneTargetBoundAsBothAdoptedAndBackground: rebound(id(97), {
      targets: [
        offlineRequirementAdopted,
        { ...offlineRequirementAdopted, designation: 'background' },
      ],
    }),
  },
};

/** A real hash, because a restatement is word for word or it is not a restatement. */
const offlineStatementSha256 = createHash('sha256').update(firstRevision.statement).digest('hex');

const restatingPassage: SourceSelector = {
  source_id: id(64),
  location: 'message 9',
  passage_sha256: offlineStatementSha256,
};

/** A later instruction whose whole text repeats the requirement, read by the processor. */
const restatingSource: SourceOccurrence = {
  source_id: restatingPassage.source_id,
  occurrence: {
    kind: 'user_instruction',
    retention: { kind: 'bytes', content_sha256: offlineStatementSha256 },
    location: restatingPassage.location,
    source_time: '2026-09-18T07:55:00.000Z',
  },
  source_author: reportedOwner,
  recorded_by: agent,
  interpreted_by: processor,
  access_restriction: null,
};

const instructionRepeatingTheRequirement: PassageRestatement = {
  restatement_id: id(160),
  passage: restatingPassage,
  restates: offlineRequirement,
  attributed_to: processor,
  recorded_at: '2026-09-18T08:00:00.000Z',
};

/** The passage the rule was read from: its own, and so never a second occurrence of itself. */
const theRulesOwnPassage: SourceSelector = {
  ...offlinePassage,
  passage_sha256: offlineStatementSha256,
};

/** The revision cites a passage of its own; the restating one is somewhere else entirely. */
const theOfflineRule = {
  passages: [theRulesOwnPassage],
  statement: firstRevision.statement,
};

/** The later instruction's whole text, which is the rule word for word and nothing else. */
const theInstructionsText: RestatingSource = {
  kind: 'retained_text',
  text: firstRevision.statement,
};

const refusedRestatement = (
  restatement: PassageRestatement,
  restated_revision: typeof theOfflineRule,
  passage_source: RestatingSource,
  code: PassageRestatementRefusal
) => ({ restatement, restated_revision, passage_source, code });

/**
 * A second source saying, word for word, what a revision already says. It is
 * the whole of what a repeated capture adds: one more retained occurrence, no
 * second identity, no successor revision identical to its predecessor, and
 * nothing that stands moved. Word for word is the hash AND the words being in
 * the source that claims them, so a paraphrase is a proposed revision instead,
 * a source that says something else corroborates nothing, and the revision's
 * own passage is not a second occurrence of itself.
 */
export const passageRestatement = {
  restatingSource,
  statement: firstRevision.statement,
  instructionRepeatingTheRequirement,
  restatedRevision: theOfflineRule,
  restatingText: theInstructionsText,
  anActorNoticedItToo: {
    ...instructionRepeatingTheRequirement,
    restatement_id: id(161),
    attributed_to: by(owner),
  },
  refused: {
    'a paraphrase of what the revision states': refusedRestatement(
      instructionRepeatingTheRequirement,
      { ...theOfflineRule, statement: `${firstRevision.statement} Always.` },
      theInstructionsText,
      'RESTATED_STATEMENT_NOT_VERBATIM'
    ),
    'a source that states something else entirely': refusedRestatement(
      instructionRepeatingTheRequirement,
      theOfflineRule,
      { kind: 'retained_text', text: 'Completely unrelated text about the weather.' },
      'STATEMENT_NOT_IN_THE_SOURCE'
    ),
    'a source held only by an immutable reference': refusedRestatement(
      instructionRepeatingTheRequirement,
      theOfflineRule,
      { kind: 'retained_reference' },
      'SOURCE_RETAINED_ONLY_BY_REFERENCE'
    ),
    'the passage the revision cites itself': refusedRestatement(
      { ...instructionRepeatingTheRequirement, passage: theRulesOwnPassage },
      theOfflineRule,
      theInstructionsText,
      'PASSAGE_ALREADY_CITED_BY_THE_REVISION'
    ),
    aRelationshipAsTheThingRestated: {
      ...instructionRepeatingTheRequirement,
      restates: replacementRelationship,
    },
  },
};

const adoptionUnderTheBinding: Selection = {
  selection_id: id(65),
  kind: 'accepted',
  target: offlineRequirement,
  scope: project,
  designation: 'adopted',
  selected_by: owner,
  authorization: { kind: 'approval_binding', binding_id: boundApproval.binding_id },
  expected_state: { kind: 'initial' },
};

const cloudOnlyReportContext: ApplicabilitySelector = {
  all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-only-report'] }],
};

const cloudOnlyReportExceptionId = id(96);

const exceptionAuthorization: AuthorizationRecord = {
  authorization_id: id(102),
  instruction: {
    kind: 'informed_instruction',
    instruction_source_id: id(57),
    acknowledged: [offlineRequirement],
    scope: project,
  },
  adopts: [],
  departs_from: [
    departure(offlineRequirement, 'excepts', { exception_id: cloudOnlyReportExceptionId }),
  ],
  restates: [],
  context: cloudOnlyReportContext,
  granted_by: reportedOwner,
  recorded_at: '2026-09-17T10:00:00.000Z',
};

/** Adopts two revisions and approves one of them as the replacement. */
const approvalOfTwoAdoptions = rebound(id(106), {
  targets: [
    ...approvalOfTheSuccessor.targets,
    {
      target: { kind: 'revision', revision: storageDecision },
      scope: project,
      designation: 'adopted',
    },
  ],
  departures: approvalOfTheSuccessor.departures,
});

/** The approver was shown this one exception, by name. */
const approvalOfTheException = rebound(id(104), {
  targets: [],
  departures: [
    {
      departure: departure(offlineRequirement, 'excepts', {
        exception_id: cloudOnlyReportExceptionId,
      }),
      scope: project,
    },
  ],
});

const earlierInThisWork = (
  record: AuthorizationRecord,
  covers_this_work: Applicability,
  valid = true
): AuthorizationContext['earlier'][number] => ({
  authorization_id: record.authorization_id,
  scope: record.instruction.scope,
  adopts: record.adopts,
  departs_from: record.departs_from,
  restates: record.restates,
  covers_this_work,
  valid,
});

const contextFor = (
  earlier: AuthorizationContext['earlier'] = [earlierInThisWork(exceptionAuthorization, 'applies')],
  assignments: AuthorizationContext['assignments'] = []
): AuthorizationContext => ({
  bindings: [
    boundApproval,
    approvalOfTheSuccessor,
    approvalOfTwoAdoptions,
    approvalOfTheException,
    exactApprovalBinding.planApprovedWithNoTargets,
  ],
  earlier,
  assignments,
});

type AuthorizationCheck = Parameters<typeof checkAuthorization>[0];

const authority = (
  authorization: Authorization,
  footprint: Partial<ActFootprint>,
  scope: AuthorityScope = project,
  context: AuthorizationContext = contextFor(),
  acting: Attribution | null = by(owner)
): AuthorizationCheck => ({
  authorization,
  scope,
  footprint: { adopts: [], departs_from: [], restates: [], ...footprint },
  acting,
  context,
});

const refusedAuthority = (check: AuthorizationCheck, code: AuthorizationRefusal) => ({
  check,
  code,
});

const adopting = (
  revision: RecordRevisionRef,
  designation: 'adopted' | 'background' = 'adopted'
): Partial<ActFootprint> => ({ adopts: [{ revision, designation }] });
const excepting = (rule: ExpectationRevisionRef, exception_id = cloudOnlyReportExceptionId) => ({
  departs_from: [departure(rule, 'excepts', { exception_id })],
});
const withdrawing = (rule: ExpectationRevisionRef) => ({
  departs_from: [departure(rule, 'withdraws')],
});
const replacing = (
  rule: ExpectationRevisionRef,
  successor: RecordRevisionRef
): Partial<ActFootprint> => ({
  adopts: [{ revision: successor, designation: 'adopted' }],
  departs_from: [departure(rule, 'replaces', { replaced_by: successor })],
});

const underBinding = (binding: ApprovalBinding): Authorization => ({
  kind: 'approval_binding',
  binding_id: binding.binding_id,
});
const reusing = (authorization_id: string): Authorization => ({
  kind: 'reused_authorization',
  authorization_id,
});

/** Whatever is cited must exist and must cover everything the act adopts, departs from and restates. */
export const authorityInTheStore = {
  adoptionUnderTheBinding,
  exceptionAuthorization,
  context: contextFor(),
  covered: {
    'an adoption the binding names': authority(
      underBinding(boundApproval),
      adopting(offlineRequirement)
    ),
    'a replacement the approver was shown': authority(
      underBinding(approvalOfTheSuccessor),
      replacing(offlineRequirement, offlineRequirementWithSearch)
    ),
    'an exception the approver was shown by name': authority(
      underBinding(approvalOfTheException),
      excepting(offlineRequirement)
    ),
    'the same exception an earlier authorization covered, for the same work': authority(
      reusing(exceptionAuthorization.authorization_id),
      excepting(offlineRequirement)
    ),
    'a departure the instruction acknowledges': authority(
      informedAbout([offlineRequirement]),
      withdrawing(offlineRequirement)
    ),
    'a finding restated on an instruction in scope': authority(explicitInstruction(), {
      restates: [defectClaim],
    }),
  },
  refused: {
    'an act that adopts nothing, departs from nothing and restates nothing': refusedAuthority(
      authority(underBinding(exactApprovalBinding.planApprovedWithNoTargets), {}),
      'NOTHING_TO_AUTHORIZE'
    ),
    'a departure under a plan approved with no targets': refusedAuthority(
      authority(
        underBinding(exactApprovalBinding.planApprovedWithNoTargets),
        withdrawing(offlineRequirement)
      ),
      'BINDING_DOES_NOT_COVER_DEPARTURE'
    ),
    'a binding that does not exist': refusedAuthority(
      authority({ kind: 'approval_binding', binding_id: id(999) }, adopting(offlineRequirement)),
      'BINDING_NOT_FOUND'
    ),
    'a binding for another scope': refusedAuthority(
      authority(underBinding(boundApproval), adopting(offlineRequirement), retryArtifact),
      'BINDING_DOES_NOT_COVER_ADOPTION'
    ),
    'a binding for another designation': refusedAuthority(
      authority(underBinding(boundApproval), adopting(offlineRequirement, 'background')),
      'BINDING_DOES_NOT_COVER_ADOPTION'
    ),
    'a binding for another revision': refusedAuthority(
      authority(underBinding(boundApproval), adopting(offlineRequirementWithSearch)),
      'BINDING_DOES_NOT_COVER_ADOPTION'
    ),
    'an approved adoption used to retire a rule the approver never saw': refusedAuthority(
      authority(underBinding(approvalOfTheSuccessor), {
        ...replacing(offlineRequirement, offlineRequirementWithSearch),
        departs_from: [
          departure(storageDecision, 'replaces', { replaced_by: offlineRequirementWithSearch }),
        ],
      }),
      'BINDING_DOES_NOT_COVER_DEPARTURE'
    ),
    'an approved replacement cited to withdraw the rule outright': refusedAuthority(
      authority(underBinding(approvalOfTheSuccessor), withdrawing(offlineRequirement)),
      'BINDING_DOES_NOT_COVER_DEPARTURE'
    ),
    'an approved replacement cited without adopting its successor': refusedAuthority(
      authority(underBinding(approvalOfTheSuccessor), {
        departs_from: [
          departure(offlineRequirement, 'replaces', { replaced_by: offlineRequirementWithSearch }),
        ],
      }),
      'BINDING_DOES_NOT_COVER_DEPARTURE'
    ),
    'an approved replacement cited for an exception to the same rule': refusedAuthority(
      authority(underBinding(approvalOfTheSuccessor), excepting(offlineRequirement)),
      'BINDING_DOES_NOT_COVER_DEPARTURE'
    ),
    'an approved replacement cited to replace the rule with something else it adopted':
      refusedAuthority(
        authority(
          underBinding(approvalOfTwoAdoptions),
          replacing(offlineRequirement, storageDecision)
        ),
        'BINDING_DOES_NOT_COVER_DEPARTURE'
      ),
    'an approved exception cited for a different exception': refusedAuthority(
      authority(underBinding(approvalOfTheException), excepting(offlineRequirement, id(100))),
      'BINDING_DOES_NOT_COVER_DEPARTURE'
    ),
    'a binding cited to restate a finding': refusedAuthority(
      authority(underBinding(boundApproval), {
        ...adopting(offlineRequirement),
        restates: [defectClaim],
      }),
      'BINDING_DOES_NOT_COVER_RESTATEMENT'
    ),
    'an earlier authorization that does not exist': refusedAuthority(
      authority(reusing(id(999)), excepting(offlineRequirement)),
      'AUTHORIZATION_NOT_FOUND'
    ),
    'an earlier authorization no longer valid': refusedAuthority(
      authority(
        reusing(exceptionAuthorization.authorization_id),
        excepting(offlineRequirement),
        project,
        contextFor([earlierInThisWork(exceptionAuthorization, 'applies', false)])
      ),
      'AUTHORIZATION_NOT_VALID'
    ),
    'an earlier authorization for another scope': refusedAuthority(
      authority(
        reusing(exceptionAuthorization.authorization_id),
        excepting(offlineRequirement),
        retryArtifact
      ),
      'SCOPE_EXCEEDS_AUTHORIZATION'
    ),
    'an earlier narrow exception reused for different work': refusedAuthority(
      authority(
        reusing(exceptionAuthorization.authorization_id),
        excepting(offlineRequirement),
        project,
        contextFor([earlierInThisWork(exceptionAuthorization, 'does_not_apply')])
      ),
      'AUTHORIZATION_DOES_NOT_COVER_THIS_WORK'
    ),
    'an earlier exception reused to withdraw the rule': refusedAuthority(
      authority(reusing(exceptionAuthorization.authorization_id), withdrawing(offlineRequirement)),
      'AUTHORIZATION_DOES_NOT_COVER_DEPARTURE'
    ),
    'an earlier exception reused to replace the rule project wide': refusedAuthority(
      authority(
        reusing(exceptionAuthorization.authorization_id),
        replacing(offlineRequirement, offlineRequirementWithSearch)
      ),
      'AUTHORIZATION_DOES_NOT_COVER_ADOPTION'
    ),
    'an earlier authorization reused to adopt an unrelated decision': refusedAuthority(
      authority(reusing(exceptionAuthorization.authorization_id), adopting(storageDecision)),
      'AUTHORIZATION_DOES_NOT_COVER_ADOPTION'
    ),
    'an earlier authorization reused to restate a finding': refusedAuthority(
      authority(reusing(exceptionAuthorization.authorization_id), {
        ...excepting(offlineRequirement),
        restates: [defectClaim],
      }),
      'AUTHORIZATION_DOES_NOT_COVER_RESTATEMENT'
    ),
    'an instruction scoped to one artifact adopting project wide': refusedAuthority(
      authority(explicitInstruction(retryArtifact), adopting(offlineRequirement)),
      'SCOPE_EXCEEDS_AUTHORIZATION'
    ),
    'an instruction that acknowledges nothing departing from a rule': refusedAuthority(
      authority(explicitInstruction(), withdrawing(offlineRequirement)),
      'RULE_NOT_ACKNOWLEDGED'
    ),
  },
  standingBeside: {
    successorBesideTheAdoptedRevision: {
      selection: {
        ...adoptionUnderTheBinding,
        selection_id: id(67),
        target: offlineRequirementWithSearch,
        authorization: explicitInstruction(),
        expected_state: observed([adoptionUnderTheBinding.selection_id], []),
      } satisfies Selection,
      adoptedBeside: [offlineRequirement],
    },
    acknowledging: informedAbout([offlineRequirement]),
  },
  correctionsRefusedOnAuthority: {
    'a replacement authorized for an unrelated rule': refusedCorrection(
      {
        action: {
          ...replacementOfTheStorageDecision,
          authorization: informedAbout([offlineRequirement]),
        },
        followed: null,
      },
      'RULE_NOT_ACKNOWLEDGED'
    ),
    'a replacement authorized in a narrower scope': refusedCorrection(
      {
        action: {
          ...replacementOfTheStorageDecision,
          authorization: informedAbout([storageDecision], retryArtifact),
        },
        followed: null,
      },
      'SCOPE_EXCEEDS_AUTHORIZATION'
    ),
    'a withdrawal of a requirement under an approval that only replaced it': refusedCorrection(
      {
        action: {
          ...withdrawalOfAFinding,
          targets: [offlineRequirement],
          scope: project,
          attributed_to: by(owner),
          authorization: underBinding(approvalOfTheSuccessor),
        },
        followed: null,
      },
      'BINDING_DOES_NOT_COVER_DEPARTURE'
    ),
    'a withdrawal of a requirement on an earlier exception to it': refusedCorrection(
      {
        action: {
          ...withdrawalOfAFinding,
          targets: [offlineRequirement],
          scope: project,
          attributed_to: by(owner),
          authorization: reusing(exceptionAuthorization.authorization_id),
        },
        followed: null,
      },
      'AUTHORIZATION_DOES_NOT_COVER_DEPARTURE'
    ),
  },
  refusedRecords: {
    anAuthorizationThatAuthorizesNothing: { ...exceptionAuthorization, departs_from: [] },
    anAuthorizationDepartingFromARuleItNeverAcknowledged: {
      ...exceptionAuthorization,
      departs_from: [
        departure(storageDecision, 'excepts', { exception_id: cloudOnlyReportExceptionId }),
      ],
    },
    aDepartureThatExceptsWithoutNamingItsException: {
      ...exceptionAuthorization,
      departs_from: [departure(offlineRequirement, 'excepts')],
    },
  },
};

const cloudStartupConflict = [offlineRequirement];

const earlierAnswer = (
  outcome: EarlierConflictAnswer['outcome'],
  covers_this_work: Applicability,
  answered_at = '2026-09-17T10:00:00.000Z',
  valid = true
): EarlierConflictAnswer => ({
  answer_id: outcome === 'authorized' ? id(95) : id(103),
  rule: offlineRequirement,
  outcome,
  answered_at,
  covers_this_work,
  valid,
});

const conflictCase = (
  conflicting: ExpectationRevisionRef[],
  acknowledged: ExpectationRevisionRef[],
  earlier: EarlierConflictAnswer[],
  disposition: Partial<ConflictDisposition> & Pick<ConflictDisposition, 'action'>,
  standing: { assignments?: ApplicableAssignment[]; acting?: Attribution | null } = {}
) => ({
  input: { conflicting, acknowledged, earlier, ...standing },
  disposition: {
    unacknowledged: [],
    declined: [],
    answer_ids: [],
    assignment_ids: [],
    ...disposition,
  } satisfies ConflictDisposition,
});

const cloudOnlyReportException: KnowledgeException = {
  exception_id: cloudOnlyReportExceptionId,
  expectation: offlineRequirement,
  context: cloudOnlyReportContext,
  scope: project,
  rationale: 'The usage report is Cloud-only by nature; local capture is unaffected.',
  granted_by: reportedOwner,
  source_id: id(57),
  authorization: informedAbout([offlineRequirement]),
  ends: { kind: 'unknown' },
  end_behavior: 'review_required',
  expected_state: observed([id(60)], []),
};

const acceptedSelection: Selection = {
  selection_id: id(61),
  kind: 'accepted',
  target: offlineRequirement,
  scope: project,
  designation: 'adopted',
  selected_by: reportedOwner,
  authorization: explicitInstruction(),
  expected_state: { kind: 'initial' },
};

const finishedTaskChoice: Selection = {
  selection_id: id(62),
  kind: 'final_recorded',
  target: offlineRequirement,
  scope: retryArtifact,
  designation: null,
  selected_by: agent,
  authorization: null,
  expected_state: observed([id(60)], []),
};

const declinedCloudStartup: ConflictAnswer = {
  answer_id: id(103),
  rule: offlineRequirement,
  outcome: 'declined',
  context: {
    all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-startup'] }],
  },
  scope: project,
  answered_by: reportedOwner,
  source_id: id(59),
  answered_at: '2026-09-18T10:00:00.000Z',
  authorization_id: null,
};

const revokedException: Revocation = {
  revocation_id: id(105),
  revokes: { kind: 'exception', id: cloudOnlyReportExceptionId },
  scope: project,
  revoked_by: reportedOwner,
  source_id: id(59),
  instruction: { kind: 'explicit_instruction', instruction_source_id: id(59), scope: project },
  recorded_at: '2026-10-01T10:00:00.000Z',
};

/**
 * An instruction that acknowledges the rule it changes proceeds. One that does
 * not is asked once, and a conflict already answered for this same work is not
 * asked again, whichever way it was answered.
 */
export const informedAuthorization = {
  conflicts: {
    'proceeds when the instruction acknowledges the rule': conflictCase(
      cloudStartupConflict,
      [offlineRequirement],
      [],
      { action: 'proceed' }
    ),
    'asks once when it does not': conflictCase(cloudStartupConflict, [], [], {
      action: 'ask_once',
      unacknowledged: cloudStartupConflict,
    }),
    'asks only about the rule left unacknowledged': conflictCase(
      [offlineRequirement, storageDecision],
      [storageDecision],
      [],
      { action: 'ask_once', unacknowledged: [offlineRequirement] }
    ),
    'reuses an authorization given earlier for this same work': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('authorized', 'applies')],
      { action: 'reuse_authorization', answer_ids: [id(95)] }
    ),
    'asks when the earlier authorization was for different work': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('authorized', 'does_not_apply')],
      { action: 'ask_once', unacknowledged: cloudStartupConflict }
    ),
    'asks when it cannot tell whether the earlier authorization covers this work': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('authorized', 'unresolved')],
      { action: 'ask_once', unacknowledged: cloudStartupConflict }
    ),
    'asks again when the earlier authorization is no longer valid': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('authorized', 'applies', '2026-09-17T10:00:00.000Z', false)],
      { action: 'ask_once', unacknowledged: cloudStartupConflict }
    ),
    'complies without asking again when the change was refused earlier': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('declined', 'applies')],
      { action: 'comply', declined: cloudStartupConflict }
    ),
    'treats an answer whose time cannot be read as no answer': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('authorized', 'applies', 'not-a-date')],
      { action: 'ask_once', unacknowledged: cloudStartupConflict }
    ),
    'lets the refusal stand when two answers share an instant, in either order': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('declined', 'applies'), earlierAnswer('authorized', 'applies')],
      { action: 'comply', declined: cloudStartupConflict }
    ),
    'lets a later refusal stand over an earlier authorization': conflictCase(
      cloudStartupConflict,
      [],
      [
        earlierAnswer('authorized', 'applies', '2026-09-17T10:00:00.000Z'),
        earlierAnswer('declined', 'applies', '2026-09-18T10:00:00.000Z'),
      ],
      { action: 'comply', declined: cloudStartupConflict }
    ),
  },
  acceptedException: cloudOnlyReportException,
  acceptedSelection,
  finishedTaskChoice,
  declinedCloudStartup,
  revokedException,
  editOfThePromotedCriterion: {
    sharedRevision: {
      action: 'revise_shared_requirement',
      requirement: offlineRequirement,
      proposed_statement: 'Local capture and local search work with no Cloud connection.',
      rationale: 'Search is part of the offline promise.',
    },
    taskLocalChange: {
      action: 'change_task_acceptance',
      requirement: offlineRequirement,
      artifact_id: id(11),
      step_id: id(31),
      criterion_text: 'Retry never blocks a capture while offline.',
    },
  },
  refused: {
    acceptanceWithNoAuthorization: { ...acceptedSelection, authorization: null },
    adoptionBroaderThanItsInstruction: {
      ...acceptedSelection,
      authorization: explicitInstruction(retryArtifact),
    },
    finishedTaskPresentedAsAdoption: { ...finishedTaskChoice, designation: 'adopted' },
    informedInstructionThatAcknowledgesNothing: { ...informedAbout([]), acknowledged: [] },
    promotedCriterionEditWithNoAction: {
      requirement: offlineRequirement,
      proposed_statement: 'Local capture and local search work with no Cloud connection.',
      rationale: 'Search is part of the offline promise.',
    },
    declinedAnswerNamingAnAuthorization: { ...declinedCloudStartup, authorization_id: id(102) },
    revocationOnAnInstructionFromAnotherScope: {
      ...revokedException,
      instruction: { ...revokedException.instruction, scope: retryArtifact },
    },
  },
};

const untilNextRelease: KnowledgeException = {
  ...cloudOnlyReportException,
  exception_id: id(100),
  ends: { kind: 'until_time', until: '2026-12-01T00:00:00.000Z' },
  end_behavior: 'expectation_applies_again',
};

interface ExceptionMoment {
  time?: string;
  condition_met?: boolean;
  revoked: boolean;
}

const standingAt = (
  exception: Pick<KnowledgeException, 'ends'>,
  at: ExceptionMoment,
  standing: 'in_effect' | 'ended' | 'unresolved'
) => ({ exception, at, standing });

/**
 * An exception names its end and what happens then. Ending proves nothing and
 * an end that cannot be evaluated stays unresolved.
 */
export const exceptionEndings = {
  accepted: { cloudOnlyReportException, untilNextRelease },
  standing: {
    'is in effect before its end time': standingAt(
      untilNextRelease,
      { time: '2026-11-30T23:59:59.000Z', revoked: false },
      'in_effect'
    ),
    'has ended at its end time': standingAt(
      untilNextRelease,
      { time: '2026-12-01T00:00:00.000Z', revoked: false },
      'ended'
    ),
    'is unresolved when the time cannot be read': standingAt(
      untilNextRelease,
      { time: 'not-a-date', revoked: false },
      'unresolved'
    ),
    'is unresolved when its own end time cannot be read': standingAt(
      { ends: { kind: 'until_time', until: 'not-a-date' } },
      { time: '2026-11-30T23:59:59.000Z', revoked: false },
      'unresolved'
    ),
    'stays unresolved while its end condition is unknown': standingAt(
      cloudOnlyReportException,
      { revoked: false },
      'unresolved'
    ),
    'has ended once revoked, whatever its end condition': standingAt(
      cloudOnlyReportException,
      { revoked: true },
      'ended'
    ),
  },
  refused: {
    'an exception that acknowledges an unrelated rule': {
      exception: { ...cloudOnlyReportException, authorization: informedAbout([storageDecision]) },
      paths: ['authorization'],
    },
    'an exception on an instruction that acknowledges nothing': {
      exception: { ...cloudOnlyReportException, authorization: explicitInstruction() },
      paths: ['authorization'],
    },
    'an exception that applies everywhere with no known end': {
      exception: { ...cloudOnlyReportException, context: { all_of: [] } },
      paths: ['ends'],
    },
    'an expiring exception with no end behavior': {
      exception: { ...untilNextRelease, end_behavior: 'none_recorded' },
      paths: ['end_behavior'],
    },
  },
};

const offlineCaptureSelector: ApplicabilitySelector = {
  all_of: [
    { dimension: 'subject', operator: 'any_of', values: ['capture'] },
    { dimension: 'environment', operator: 'any_of', values: ['offline'] },
    { dimension: 'time', operator: 'from', instant: '2026-01-01T00:00:00.000Z' },
  ],
};

const endsAtNewYear: ApplicabilitySelector = {
  all_of: [{ dimension: 'time', operator: 'before', instant: '2026-01-01T00:00:00.000Z' }],
};

const lookup = (
  selector: ApplicabilitySelector,
  inputs: ApplicabilityInputs,
  applicability: Applicability
) => ({ selector, inputs, applicability });

const everyInput = (time: string): ApplicabilityInputs => ({
  subject: ['capture'],
  environment: ['offline'],
  time,
});

export const applicabilityLookup = {
  'applies when every input is known and met': lookup(
    offlineCaptureSelector,
    everyInput('2026-09-17T00:00:00.000Z'),
    'applies'
  ),
  'stays unresolved with no implementation or environment selected': lookup(
    offlineCaptureSelector,
    { subject: ['capture'] },
    'unresolved'
  ),
  'does not apply once one condition is definitely false': lookup(
    offlineCaptureSelector,
    { subject: ['sync'] },
    'does_not_apply'
  ),
  'stays unresolved when the time cannot be read': lookup(
    offlineCaptureSelector,
    everyInput('not-a-date'),
    'unresolved'
  ),
  'stays unresolved when an input is known to be empty': lookup(
    offlineCaptureSelector,
    { ...everyInput('2026-09-17T00:00:00.000Z'), environment: [] },
    'unresolved'
  ),
  'starts at its own instant': lookup(
    offlineCaptureSelector,
    everyInput('2026-01-01T00:00:00.000Z'),
    'applies'
  ),
  'has ended at the instant its successor starts': lookup(
    endsAtNewYear,
    { time: '2026-01-01T00:00:00.000Z' },
    'does_not_apply'
  ),
};

const replaces = (from: RecordRevisionRef, to: RecordRevisionRef) => ({
  relation: 'supersedes' as const,
  from,
  to,
});

const decisionRevision = (revision_id: string): RecordRevisionRef => ({
  ...storageDecision,
  revision_id,
});

const establishedReplacement: Relationship = {
  relationship_id: id(110),
  ...replaces(storageDecisionSuccessor, storageDecision),
  scope: project,
  standing: 'established',
  attributed_to: by(reportedOwner),
  authorization: informedAbout([storageDecision]),
  source_ids: [id(54)],
  explanation: 'The owner replaced the storage decision after the migration review.',
};

const suggestedDependency: Relationship = {
  relationship_id: id(111),
  relation: 'depends_on',
  from: offlineRequirement,
  to: storageDecision,
  scope: project,
  standing: 'suggested',
  attributed_to: processor,
  authorization: null,
  source_ids: [id(50)],
  explanation: 'Offline capture relies on the on-device storage decision.',
};

/** Background processing suggests; only an actor with authority establishes. */
/** A relationship has no revisions of its own, so a reference to one names it twice. */
export const relationshipReference = {
  accepted: replacementRelationship,
  refusedWithARevisionOfItsOwn: { ...replacementRelationship, revision_id: id(113) },
};

export const relationships = {
  establishedReplacement,
  suggestedDependency,
  cycles: {
    existing: [replaces(storageDecisionSuccessor, storageDecision)],
    closesALoop: replaces(storageDecision, storageDecisionSuccessor),
    extendsTheChain: replaces(decisionRevision(id(75)), storageDecisionSuccessor),
    importedHistoryAlreadyCyclic: [
      replaces(storageDecisionSuccessor, storageDecision),
      replaces(storageDecision, storageDecisionSuccessor),
    ],
    aDependencyThatPointsBack: {
      relation: 'depends_on' as const,
      from: storageDecision,
      to: storageDecisionSuccessor,
    },
  },
  refused: {
    'a relationship established by a detector': {
      relationship: { ...suggestedDependency, standing: 'established' },
      paths: ['standing'],
    },
    'an established replacement with no authorization': {
      relationship: { ...establishedReplacement, authorization: null },
      paths: ['authorization'],
    },
    'an established replacement that acknowledges another rule': {
      relationship: {
        ...establishedReplacement,
        authorization: informedAbout([offlineRequirement]),
      },
      paths: ['authorization'],
    },
    'a requirement replacing a finding': {
      relationship: {
        ...establishedReplacement,
        from: offlineRequirement,
        to: defectClaim,
        authorization: null,
      },
      paths: ['to'],
    },
    'an established replacement resting on an approval binding': {
      relationship: {
        ...establishedReplacement,
        authorization: { kind: 'approval_binding', binding_id: id(90) },
      },
      paths: ['authorization'],
    },
    'a relationship that points at another relationship': {
      relationship: { ...suggestedDependency, to: replacementRelationship },
      paths: ['to'],
    },
    'a relationship from a revision to itself': {
      relationship: { ...suggestedDependency, to: offlineRequirement },
      paths: ['to'],
    },
  },
};

const releaseBuild = { kind: 'release' as const, identity: 'example-app@2.4.0' };

const offlineSmokeRun: Observation = {
  observation_id: id(120),
  observer: { identity: 'evaluator-runner', basis: 'source_attributed' },
  source_id: id(58),
  method: { name: 'offline-capture-smoke', configuration_sha256: hash('c') },
  execution: {
    kind: 'runner_established',
    runner: 'evaluator-runner',
    consumed_inputs: [releaseBuild],
  },
  input_basis: 'snapshot_bound',
  known_inputs: [releaseBuild],
  outcome: 'passed',
  detail: null,
  retained_artifacts: ['offline-capture-smoke.log'],
  started_at: '2026-09-17T11:00:00.000Z',
  finished_at: '2026-09-17T11:00:42.000Z',
  limits: ['Exercises capture and local search with the network disabled; nothing else.'],
};

const assessmentOfTheRelease: Assessment = {
  assessment_id: id(121),
  expectations: [offlineRequirementWithSearch],
  exception_ids: [],
  implementation: { kind: 'selected', inputs: [releaseBuild], environment: 'offline' },
  evidence: [
    {
      source: { kind: 'observation', observation_id: offlineSmokeRun.observation_id },
      role: 'supports',
      limitations: 'One run on one platform.',
    },
  ],
  assessor: agent,
  method: { name: 'manual-review-of-observations', configuration_sha256: null },
  conclusions: [
    {
      expectation: offlineRequirementWithSearch,
      conclusion: 'supported',
      reason: 'The release captured and searched with the network disabled.',
    },
  ],
  check_states: [],
  coverage_limits: ['One release on one platform.'],
  observed_write_sequence: 120,
  observed_intent_counter: 14,
};

const lookupBeforeAnyCode: Assessment = {
  ...assessmentOfTheRelease,
  assessment_id: id(122),
  implementation: { kind: 'none_selected' },
  evidence: [],
  conclusions: [
    {
      expectation: offlineRequirementWithSearch,
      conclusion: 'unresolved',
      reason: 'No software was selected, so nothing can be said about satisfaction.',
    },
  ],
};

/** Evidence is about identified inputs, and a conclusion is about identified software. */
export const evidenceAndAssessment = {
  offlineSmokeRun,
  assessmentOfTheRelease,
  lookupBeforeAnyCode,
  refused: {
    'an agent-reported command presented as snapshot bound': {
      schema: 'observation',
      input: {
        ...offlineSmokeRun,
        execution: { kind: 'agent_reported', command: 'pnpm test offline-capture' },
      },
      paths: ['input_basis'],
    },
    'a snapshot-bound run that consumed other inputs than it claims to know': {
      schema: 'observation',
      input: {
        ...offlineSmokeRun,
        known_inputs: [{ kind: 'release', identity: 'example-app@2.5.0' }],
      },
      paths: ['input_basis'],
    },
    'a satisfaction claim against unidentified software': {
      schema: 'assessment',
      input: {
        ...lookupBeforeAnyCode,
        evidence: assessmentOfTheRelease.evidence,
        conclusions: assessmentOfTheRelease.conclusions,
      },
      paths: ['implementation'],
    },
    'a selected expectation left without a conclusion': {
      schema: 'assessment',
      input: { ...assessmentOfTheRelease, conclusions: [] },
      paths: ['conclusions'],
    },
    'a supported conclusion with no supporting evidence': {
      schema: 'assessment',
      input: {
        ...assessmentOfTheRelease,
        evidence: [{ ...assessmentOfTheRelease.evidence[0], role: 'contradicts' }],
      },
      paths: ['evidence'],
    },
    'an assessment cited as evidence for itself': {
      schema: 'assessment',
      input: {
        ...assessmentOfTheRelease,
        evidence: [
          ...assessmentOfTheRelease.evidence,
          {
            source: { kind: 'assessment', assessment_id: assessmentOfTheRelease.assessment_id },
            role: 'context',
            limitations: null,
          },
        ],
      },
      paths: ['evidence'],
    },
  },
} as const;

const retryException = id(141);

/**
 * One assignment: the agent may except the offline requirement inside the retry
 * artifact and nothing else. The prose beside it is for people and is never
 * parsed; `delegated` is the whole of what an act under it is judged against.
 */
const retryAssignment: Assignment = {
  assignment_id: id(140),
  objective: 'Make upload retries idempotent without touching offline capture.',
  inherited: [offlineRequirement],
  delegated: {
    adopts: [],
    departs_from: [departure(offlineRequirement, 'excepts', { exception_id: retryException })],
    restates: [],
  },
  allowed_changes: ['Retry scheduling and backoff inside the upload queue.'],
  escalation_conditions: ['Any change to what is captured while offline.'],
  responsible: agent,
  assigned_by: reportedOwner,
  source_id: id(57),
  scope: retryArtifact,
  authorization: informedAbout([offlineRequirement], retryArtifact),
  valid_until: null,
};

const restingOn = (assignment: Assignment): Authorization => ({
  kind: 'assignment',
  assignment_id: assignment.assignment_id,
});

const delegatedBy = (
  assignment: Assignment,
  standing: { valid?: boolean; covers_this_work?: Applicability } = {}
): AuthorizationContext['assignments'][number] => ({
  assignment_id: assignment.assignment_id,
  scope: assignment.scope,
  delegated: assignment.delegated,
  responsible: assignment.responsible,
  covers_this_work: standing.covers_this_work ?? 'applies',
  valid: standing.valid ?? true,
});

const underAssignment = (
  footprint: Partial<ActFootprint>,
  standing: { valid?: boolean; covers_this_work?: Applicability } = {},
  scope: AuthorityScope = retryArtifact,
  acting: Attribution | null = by(agent)
): AuthorizationCheck =>
  authority(
    restingOn(retryAssignment),
    footprint,
    scope,
    contextFor(undefined, [delegatedBy(retryAssignment, standing)]),
    acting
  );

const coveringAssignment = (
  standing: { valid?: boolean; covers_this_work?: Applicability } = {}
): ApplicableAssignment => ({
  assignment_id: retryAssignment.assignment_id,
  responsible: retryAssignment.responsible,
  departs_from: retryAssignment.delegated.departs_from,
  valid: standing.valid ?? true,
  covers_this_work: standing.covers_this_work ?? 'applies',
});

/**
 * An assignment delegates a footprint and nothing else. What it inherits and
 * what it delegates are judged against the assigner's own authority when it is
 * published; an act citing it is judged against the delegated footprint, its
 * validity, and whether the act claims the identity it made responsible.
 */
export const delegation = {
  retryAssignment,
  refused: {
    assignmentBroaderThanItsInstruction: { ...retryAssignment, scope: project },
    assignmentDepartingFromARuleItsInstructionNeverAcknowledged: {
      ...retryAssignment,
      delegated: {
        ...retryAssignment.delegated,
        departs_from: [departure(storageDecision, 'withdraws')],
      },
    },
    assignmentRestingOnAnAuthorizationGivenForOneAct: {
      ...retryAssignment,
      authorization: reusing(exceptionAuthorization.authorization_id),
    },
    assignmentWithNobodyResponsible: { ...retryAssignment, responsible: unknownActor },
  },
  covered: {
    'the exception it delegates, by the party it made responsible': underAssignment(
      excepting(offlineRequirement, retryException)
    ),
  },
  refusedAuthority: {
    'an assignment that does not exist': refusedAuthority(
      authority(
        restingOn({ ...retryAssignment, assignment_id: id(999) }),
        excepting(offlineRequirement, retryException),
        retryArtifact,
        contextFor(undefined, []),
        by(agent)
      ),
      'ASSIGNMENT_NOT_FOUND'
    ),
    'an assignment a revocation ended': refusedAuthority(
      underAssignment(excepting(offlineRequirement, retryException), { valid: false }),
      'ASSIGNMENT_NOT_VALID'
    ),
    'an assignment whose validity ended before this act': refusedAuthority(
      underAssignment(excepting(offlineRequirement, retryException), {
        covers_this_work: 'does_not_apply',
      }),
      'ASSIGNMENT_NOT_VALID'
    ),
    'an act with no judged time under an assignment that ends': refusedAuthority(
      underAssignment(excepting(offlineRequirement, retryException), {
        covers_this_work: 'unresolved',
      }),
      'ASSIGNMENT_NOT_VALID'
    ),
    'an assignment cited outside the scope it was given in': refusedAuthority(
      underAssignment(excepting(offlineRequirement, retryException), {}, project),
      'SCOPE_EXCEEDS_AUTHORIZATION'
    ),
    'an act by somebody other than the responsible party': refusedAuthority(
      underAssignment(
        excepting(offlineRequirement, retryException),
        {},
        retryArtifact,
        by(reportedOwner)
      ),
      'ACTOR_NOT_RESPONSIBLE'
    ),
    'an act attributed to a detector': refusedAuthority(
      underAssignment(excepting(offlineRequirement, retryException), {}, retryArtifact, processor),
      'ACTOR_NOT_RESPONSIBLE'
    ),
    'a different exception to the same rule': refusedAuthority(
      underAssignment(excepting(offlineRequirement, cloudOnlyReportExceptionId)),
      'ASSIGNMENT_DOES_NOT_COVER_DEPARTURE'
    ),
    'the rule withdrawn outright': refusedAuthority(
      underAssignment(withdrawing(offlineRequirement)),
      'ASSIGNMENT_DOES_NOT_COVER_DEPARTURE'
    ),
    'an adoption it never delegated': refusedAuthority(
      underAssignment(adopting(storageDecision)),
      'ASSIGNMENT_DOES_NOT_COVER_ADOPTION'
    ),
    'a finding restated beside the exception it delegates': refusedAuthority(
      underAssignment({
        ...excepting(offlineRequirement, retryException),
        restates: [defectClaim],
      }),
      'ASSIGNMENT_DOES_NOT_COVER_RESTATEMENT'
    ),
    'an assignment that delegates nothing at all': refusedAuthority(
      underAssignment({}),
      'NOTHING_TO_AUTHORIZE'
    ),
  },
  conflicts: {
    'rests on a standing assignment instead of asking about the rule it delegates': conflictCase(
      cloudStartupConflict,
      [],
      [],
      { action: 'rest_on_assignment', assignment_ids: [retryAssignment.assignment_id] },
      { assignments: [coveringAssignment()], acting: by(agent) }
    ),
    'asks when the assignment was made to somebody else': conflictCase(
      cloudStartupConflict,
      [],
      [],
      { action: 'ask_once', unacknowledged: cloudStartupConflict },
      { assignments: [coveringAssignment()], acting: by(reportedOwner) }
    ),
    'asks when nobody is named as acting': conflictCase(
      cloudStartupConflict,
      [],
      [],
      { action: 'ask_once', unacknowledged: cloudStartupConflict },
      { assignments: [coveringAssignment()] }
    ),
    'asks once more when the assignment covering the rule was revoked': conflictCase(
      cloudStartupConflict,
      [],
      [],
      { action: 'ask_once', unacknowledged: cloudStartupConflict },
      { assignments: [coveringAssignment({ valid: false })], acting: by(agent) }
    ),
    'asks once more when the assignment no longer covers this work': conflictCase(
      cloudStartupConflict,
      [],
      [],
      { action: 'ask_once', unacknowledged: cloudStartupConflict },
      {
        assignments: [coveringAssignment({ covers_this_work: 'does_not_apply' })],
        acting: by(agent),
      }
    ),
    'names both the assignment and the answer that cover one rule': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('authorized', 'applies')],
      {
        action: 'rest_on_assignment',
        answer_ids: [id(95)],
        assignment_ids: [retryAssignment.assignment_id],
      },
      { assignments: [coveringAssignment()], acting: by(agent) }
    ),
    'complies with a refusal whatever an assignment delegates': conflictCase(
      cloudStartupConflict,
      [],
      [earlierAnswer('declined', 'applies')],
      { action: 'comply', declined: cloudStartupConflict },
      { assignments: [coveringAssignment()], acting: by(agent) }
    ),
  },
};

const approvedReplacement: CorrectionAction = {
  ...proposalBase,
  action_id: id(130),
  kind: 'accepted_replacement',
  targets: [offlineRequirement],
  replacement: offlineRequirementWithSearch,
  designation: 'adopted',
  attributed_to: by(owner),
  authorization: underBinding(approvalOfTheSuccessor),
  expected_state: observed([adoptionUnderTheBinding.selection_id], []),
};

/**
 * One requirement, followed in the order it happened: the capture that first
 * stated it, the approval that adopted it, a task's exact use, a challenge
 * that proposed and governed nothing, the approved replacement that made its
 * successor stand, and an assessment of identified software against that
 * successor. Each writing step carries the governing state it observed and,
 * where it changes what stands, the footprint its authority is judged on.
 */
export const requirementFollowedEndToEnd = {
  requirement_id: offlineCriterion.criterion_id,
  capture: criterionSource,
  identity: canonicalCriterionReuse.identity,
  revision: firstRevision,
  approval: boundApproval,
  use: useByLaterTask,
  laterApproval: approvalOfTheSuccessor,
  assessment: assessmentOfTheRelease,
  authorizationContext: contextFor(),
  steps: [
    {
      name: 'the approval adopts the first revision',
      record: adoptionUnderTheBinding,
      governs: { selection_ids: [adoptionUnderTheBinding.selection_id] },
    },
    {
      name: 'the requirement is challenged, which proposes and governs nothing',
      record: {
        ...challengeToTheRequirement,
        expected_state: observed([adoptionUnderTheBinding.selection_id], []),
      } satisfies CorrectionAction,
      governs: {},
    },
    {
      name: 'an approved replacement makes the successor stand',
      record: approvedReplacement,
      governs: { correction_action_ids: [approvedReplacement.action_id] },
    },
  ],
  standsAtTheEnd: offlineRequirementWithSearch,
};

interface AdmissionCase {
  name: string;
  input: Parameters<typeof admitsProcessingJob>[0];
  admits: boolean;
}

const settled = (
  path: AdmissionCase['input']['path'],
  origin_kind: AdmissionCase['input']['origin_kind'],
  settled_event_types: AdmissionCase['input']['settled_event_types'],
  derived_by_processing = false
) => ({ path, origin_kind, settled_event_types, derived_by_processing });

export const processingAdmission: AdmissionCase[] = [
  {
    name: 'a live plan capture',
    input: settled('live_capture_settlement', 'captured', ['plan_captured']),
    admits: true,
  },
  {
    name: 'a requirement authored outside any task',
    input: settled('live_knowledge_input', null, []),
    admits: true,
  },
  {
    name: "a reviewer's new comment, pulled or local",
    input: settled('live_review_feedback', 'captured', []),
    admits: true,
  },
  { name: 'a live observation', input: settled('live_observation', null, []), admits: true },
  {
    name: 'a record that background processing itself derived',
    input: settled('live_knowledge_input', null, [], true),
    admits: false,
  },
  {
    name: 'a knowledge record another client already published',
    input: settled('synced_knowledge_record', null, []),
    admits: false,
  },
  {
    name: 'review feedback on an imported artifact',
    input: settled('live_review_feedback', 'git-import', []),
    admits: false,
  },
  {
    name: 'an observation of an imported artifact',
    input: settled('live_observation', 'git-import', []),
    admits: false,
  },
  {
    name: 'a live checkpoint open, which retains only deterministic references',
    input: settled('live_capture_settlement', 'captured', ['checkpoint_opened']),
    admits: false,
  },
  {
    name: 'a seeded artifact, which shares the live operation kind',
    input: settled('seed_import', 'git-import', [
      'plan_captured',
      'checkpoint_closed',
      'summary_captured',
    ]),
    admits: false,
  },
  {
    name: 'an amend of an imported artifact through the live settlement',
    input: settled('live_capture_settlement', 'git-import', ['summary_captured']),
    admits: false,
  },
  {
    name: 'legacy conversion, which keeps captured origin',
    input: settled('legacy_conversion', 'captured', ['plan_captured', 'summary_captured']),
    admits: false,
  },
  {
    name: 'a replay of an already settled capture',
    input: settled('replay', 'captured', ['plan_captured']),
    admits: false,
  },
  {
    name: 'a restored database',
    input: settled('restore', 'captured', ['plan_captured']),
    admits: false,
  },
  {
    name: 'a live capture that settled nothing',
    input: settled('live_capture_settlement', 'captured', []),
    admits: false,
  },
];
