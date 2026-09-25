import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ActorSchema,
  admitsProcessingJob,
  ApprovalBindingSchema,
  AssessmentSchema,
  AssignmentSchema,
  AuthorityScopeSchema,
  type Authorization,
  AuthorizationRecordSchema,
  AuthorizationSchema,
  bindingCoveredByApproval,
  checkAuthorization,
  checkCorrection,
  checkExpectedState,
  checkPassageRestatement,
  checkRevisionContinues,
  checkSelectorResolution,
  ClaimRevisionSchema,
  ConflictAnswerSchema,
  conflictDisposition,
  type CorrectionAction,
  CorrectionActionSchema,
  correctionChangeClass,
  correctionFootprint,
  CriterionReferenceSchema,
  DecisionRevisionSchema,
  evaluateApplicability,
  exceptionFootprint,
  ExceptionSchema,
  exceptionStanding,
  type ExpectationRevisionRef,
  ExpectedStateSchema,
  type FollowedCorrection,
  type GoverningState,
  introducesReplacementCycle,
  MAX_FOLLOWED_CHAIN,
  ObservationSchema,
  PassageRestatementSchema,
  PromotedCriterionEditSchema,
  RecordRevisionRefSchema,
  relationshipFootprint,
  RelationshipSchema,
  type RelationshipTarget,
  RequirementIdentitySchema,
  RequirementRevisionSchema,
  revisionTips,
  RevocationSchema,
  selectionFootprint,
  selectionMatchesBinding,
  SelectionSchema,
  SelectorResolutionSchema,
  SourceOccurrenceSchema,
  TaskUseSchema,
  taskUseSelection,
} from './knowledge-contract.js';
import {
  applicabilityLookup,
  authorityInTheStore,
  canonicalCriterionReuse,
  correctionAndReversal,
  delegation,
  derivedDecision,
  distinctDerivedObligation,
  evidenceAndAssessment,
  exactApprovalBinding,
  exceptionEndings,
  findingsAsClaims,
  informedAuthorization,
  owner,
  passageRestatement,
  processingAdmission,
  relationshipReference,
  relationships,
  requirementFollowedEndToEnd,
  siblingRevisions,
} from '../../tests/knowledge-contract-examples.js';

const accepts = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;

const refusalPaths = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? null : [...new Set(result.error.issues.map((i) => i.path.join('.')))];
};

describe('canonical criterion reuse', () => {
  it('gives the promoted criterion one identity, reached by other tasks through exact uses', () => {
    expect(accepts(RequirementIdentitySchema, canonicalCriterionReuse.identity)).toBe(true);
    expect(accepts(RequirementRevisionSchema, canonicalCriterionReuse.firstRevision)).toBe(true);
    expect(accepts(SourceOccurrenceSchema, canonicalCriterionReuse.source)).toBe(true);
    expect(accepts(TaskUseSchema, canonicalCriterionReuse.useByLaterTask)).toBe(true);
  });

  it('refuses a competing copy of the criterion under a new identity', () => {
    expect(
      refusalPaths(
        RequirementIdentitySchema,
        canonicalCriterionReuse.refused.competingCopyUnderNewIdentity
      )
    ).toEqual(['requirement_id']);
  });

  it('keeps a connection found after the task apart from an original selection', () => {
    expect(accepts(TaskUseSchema, canonicalCriterionReuse.connectionFoundAfterTheTask)).toBe(true);
    expect(
      accepts(
        TaskUseSchema,
        canonicalCriterionReuse.refused.laterConnectionPresentedWithoutDiscovery
      )
    ).toBe(false);
  });

  it('derives whether a use was selected with the plan from the operation that wrote it', () => {
    const { thePlanEventsOwnOperation, aLaterOperationThatSaysNothingOfDiscovery } =
      canonicalCriterionReuse.whoWroteTheUse;
    expect(taskUseSelection(thePlanEventsOwnOperation)).toEqual({
      ok: true,
      selection: { kind: 'selected_with_plan' },
    });
    expect(taskUseSelection(aLaterOperationThatSaysNothingOfDiscovery)).toEqual({
      ok: false,
      code: 'DISCOVERY_REQUIRED',
    });
  });

  it('keeps what a detector derives a candidate', () => {
    expect(
      accepts(RequirementRevisionSchema, canonicalCriterionReuse.candidateFromProcessing)
    ).toBe(true);
    expect(
      refusalPaths(
        RequirementRevisionSchema,
        canonicalCriterionReuse.refused.derivedRevisionPresentedAsAnInstruction
      )
    ).toEqual(['source_standing']);
  });

  it('keeps a source nobody interpreted apart from one a detector interpreted', () => {
    const { nobody, aDetector, anActor } = canonicalCriterionReuse.interpretation;
    expect(
      [nobody, aDetector, anActor].map((source) => accepts(SourceOccurrenceSchema, source))
    ).toEqual([true, true, true]);
    expect(nobody.interpreted_by).toBeNull();
    expect(aDetector.interpreted_by).toEqual({ kind: 'detector', detector: 'knowledge-processor' });
  });

  it('refuses a detector written into a field that says who', () => {
    const { detectorNamedAsTheInterpretingActor, detectorNamedAsTheDiscoveringActor } =
      canonicalCriterionReuse.refused;
    expect(accepts(SourceOccurrenceSchema, detectorNamedAsTheInterpretingActor)).toBe(false);
    expect(accepts(TaskUseSchema, detectorNamedAsTheDiscoveringActor)).toBe(false);
  });

  it('refuses a source that is only a mutable URL', () => {
    expect(
      accepts(SourceOccurrenceSchema, canonicalCriterionReuse.refused.sourceThatIsOnlyAMutableUrl)
    ).toBe(false);
  });

  it('refuses a named actor with an unknown basis, a blank identity, and an id with whitespace', () => {
    const { namedActorWithUnknownBasis, blankActorIdentity, recordIdContainingWhitespace } =
      canonicalCriterionReuse.refused;
    expect(accepts(ActorSchema, namedActorWithUnknownBasis)).toBe(false);
    expect(refusalPaths(ActorSchema, blankActorIdentity)).toEqual(['identity']);
    expect(refusalPaths(CriterionReferenceSchema, recordIdContainingWhitespace)).toEqual([
      'criterion_id',
    ]);
  });
});

describe('distinct derived obligation', () => {
  it('mints its own identity and records the derivation', () => {
    expect(accepts(RequirementIdentitySchema, distinctDerivedObligation.identity)).toBe(true);
  });

  it('refuses a derived obligation that shares the identity it was derived from', () => {
    expect(
      refusalPaths(
        RequirementIdentitySchema,
        distinctDerivedObligation.refused.derivedObligationSharingItsSourceIdentity
      )
    ).toEqual(['requirement_id']);
  });
});

describe('sibling revisions', () => {
  it('lets a second successor continue a revision that already has one', () => {
    expect(
      checkRevisionContinues(
        siblingRevisions.lineage,
        siblingRevisions.secondSuccessorOfTheSameRevision
      )
    ).toEqual({ ok: true });
    expect(
      revisionTips([...siblingRevisions.lineage, siblingRevisions.secondSuccessorOfTheSameRevision])
    ).toEqual(siblingRevisions.tipsAfterBoth);
  });

  it.each(Object.entries(siblingRevisions.refused))('refuses %s', (_name, refused) => {
    expect(checkRevisionContinues(siblingRevisions.lineage, refused.next)).toEqual({
      ok: false,
      code: refused.code,
    });
  });
});

describe('findings as claims', () => {
  it('states a finding, keeps what was reported about checking it apart, and continues its lineage', () => {
    expect(accepts(ClaimRevisionSchema, findingsAsClaims.duplicateUploadFinding)).toBe(true);
    expect(accepts(ClaimRevisionSchema, findingsAsClaims.findingExtractedByProcessing)).toBe(true);
    expect(findingsAsClaims.findingExtractedByProcessing.verification).toBeNull();
    expect(
      checkRevisionContinues(
        findingsAsClaims.lineage,
        findingsAsClaims.correctedAccountOfTheSameFinding
      )
    ).toEqual({ ok: true });
  });

  it.each(Object.entries(findingsAsClaims.refused))('refuses %s', (_name, refused) => {
    expect(refusalPaths(ClaimRevisionSchema, refused.revision)).toEqual(refused.paths);
  });
});

describe('a derived decision', () => {
  it('records where it came from on the revision that mints its identity', () => {
    expect(accepts(DecisionRevisionSchema, derivedDecision.retryIdempotencyDecision)).toBe(true);
    expect(accepts(DecisionRevisionSchema, derivedDecision.decisionThatCameFromNoRule)).toBe(true);
  });

  it.each(Object.entries(derivedDecision.refused))('refuses %s', (_name, refused) => {
    expect(refusalPaths(DecisionRevisionSchema, refused.revision)).toEqual(refused.paths);
  });
});

describe('a passage that restates a revision', () => {
  it('records another occurrence of the same words, whoever noticed it', () => {
    const { instructionRepeatingTheRequirement, anActorNoticedItToo, restatedRevision } =
      passageRestatement;
    for (const restatement of [instructionRepeatingTheRequirement, anActorNoticedItToo]) {
      expect(accepts(PassageRestatementSchema, restatement)).toBe(true);
      expect(
        checkPassageRestatement({
          restatement,
          restated_revision: restatedRevision,
          passage_source: passageRestatement.restatingText,
        })
      ).toEqual({ ok: true });
    }
  });

  it('refuses a relationship as the thing restated', () => {
    expect(
      refusalPaths(
        PassageRestatementSchema,
        passageRestatement.refused.aRelationshipAsTheThingRestated
      )
    ).toEqual(['restates']);
  });

  it.each([
    ['a paraphrase of what the revision states'],
    ['a source that states something else entirely'],
    ['a source held only by an immutable reference'],
    ['the passage the revision cites itself'],
  ] as const)('refuses %s', (name) => {
    const refused = passageRestatement.refused[name];
    expect(
      checkPassageRestatement({
        restatement: refused.restatement,
        restated_revision: refused.restated_revision,
        passage_source: refused.passage_source,
      })
    ).toEqual({ ok: false, code: refused.code });
  });
});

const judged = (correction: {
  action: CorrectionAction;
  followed: FollowedCorrection | null;
  standing_followers?: string[];
  relationship_targets?: RelationshipTarget[];
  adopted_beside?: ExpectationRevisionRef[];
  findings_originate_in_scope?: boolean;
}) =>
  checkCorrection({
    standing_followers: [],
    relationship_targets: [],
    adopted_beside: [],
    findings_originate_in_scope: false,
    context: authorityInTheStore.context,
    ...correction,
  });

describe('correction and reversal', () => {
  it.each(Object.entries(correctionAndReversal.accepted))('appends %s', (_name, example) => {
    expect(refusalPaths(CorrectionActionSchema, example.action)).toBeNull();
    const result = judged(example);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({
      adopts: result.footprint.adopts.length,
      departs: result.footprint.departs_from.map((departure) => departure.how),
      restates: result.footprint.restates.length,
    }).toEqual({ adopts: 0, departs: [], restates: 0, ...example.footprint });
    expect(result.change_class).toBe(example.changeClass);
    expect(correctionChangeClass(example.action, result.footprint)).toBe(example.changeClass);
  });

  it.each(Object.entries(correctionAndReversal.refusedByTheStore))(
    'refuses %s',
    (_name, { code, ...refused }) => {
      expect(refusalPaths(CorrectionActionSchema, refused.action)).toBeNull();
      expect(judged(refused)).toEqual({ ok: false, code });
    }
  );

  it.each(Object.entries(authorityInTheStore.correctionsRefusedOnAuthority))(
    'refuses %s',
    (_name, { code, ...refused }) => {
      expect(refusalPaths(CorrectionActionSchema, refused.action)).toBeNull();
      expect(judged(refused)).toEqual({ ok: false, code });
    }
  );

  it.each(Object.entries(correctionAndReversal.refused))('refuses %s', (_name, refused) => {
    expect(refusalPaths(CorrectionActionSchema, refused.action)).toEqual(refused.paths);
  });

  it('judges a reversal on what the action it follows made stand, not on what it names', () => {
    const { action, followed } =
      correctionAndReversal.accepted['a reversal judged on the replacement it undoes'];
    expect(correctionFootprint(action, null)).toEqual({
      adopts: [],
      departs_from: [],
      restates: [],
    });
    expect(
      correctionFootprint(action, followed).departs_from.map((departure) => departure.how)
    ).toEqual(['replaces', 'corrects']);
  });

  it('departs from the replaced revision, not its successor, when a replacement is put back', () => {
    const example =
      correctionAndReversal.accepted[
        'a withdrawn replacement put back by someone who acknowledged what it replaces'
      ];
    const [target] = example.relationship_targets ?? [];
    const result = judged(example);
    expect(result.ok && result.footprint.departs_from).toEqual([
      { rule: target?.to, how: 'replaces', exception_id: null, replaced_by: target?.from },
    ]);
  });

  it('withdraws a replacement again when the reversal that put it back is itself undone', () => {
    const putBack =
      correctionAndReversal.accepted[
        'a withdrawn replacement put back by someone who acknowledged what it replaces'
      ];
    const withdrawn =
      correctionAndReversal.accepted[
        'an established replacement withdrawn by someone who acknowledged what it put in place'
      ];
    const [target] = putBack.relationship_targets ?? [];
    const undoing = (authorization: CorrectionAction['authorization']) =>
      judged({
        relationship_targets: putBack.relationship_targets,
        action: {
          ...putBack.action,
          action_id: '01a0b000-0000-7000-8000-0000000000f1',
          reverses_action_id: putBack.action.action_id,
          authorization,
        } as CorrectionAction,
        followed: { action: putBack.action, followed: putBack.followed },
      });
    expect(undoing(null)).toEqual({ ok: false, code: 'AUTHORIZATION_REQUIRED' });
    expect(undoing(putBack.action.authorization)).toEqual({
      ok: false,
      code: 'RULE_NOT_ACKNOWLEDGED',
    });
    const result = undoing(withdrawn.action.authorization);
    expect(result.ok && result.footprint.departs_from).toEqual([
      { rule: target?.from, how: 'withdraws', exception_id: null, replaced_by: null },
    ]);
  });

  it('refuses an act that would follow a chain longer than the bound', () => {
    const restored =
      correctionAndReversal.accepted[
        'a withdrawn requirement restored by someone who acknowledged it'
      ];
    const first = restored.followed?.action as CorrectionAction;
    const reversal = restored.action as Extract<CorrectionAction, { kind: 'reversal' }>;
    const linkId = (n: number) =>
      `01a0b000-0000-7000-8000-${(0xf00 + n).toString(16).padStart(12, '0')}`;
    const chainOf = (links: number) => {
      let followed: FollowedCorrection = { action: first, followed: null };
      for (let n = 0; n < links; n += 1)
        followed = {
          action: {
            ...reversal,
            action_id: linkId(n),
            reverses_action_id: followed.action.action_id,
            resulting_selection: n % 2 === 0 ? reversal.resulting_selection : { kind: 'none' },
          },
          followed,
        };
      return followed;
    };
    const following = (chain: FollowedCorrection) =>
      judged({
        action: {
          ...reversal,
          action_id: linkId(999),
          reverses_action_id: chain.action.action_id,
          resulting_selection:
            chain.action.kind === 'reversal' && chain.action.resulting_selection.kind === 'revision'
              ? { kind: 'none' }
              : reversal.resulting_selection,
        },
        followed: chain,
      });
    expect(following(chainOf(MAX_FOLLOWED_CHAIN - 1)).ok).toBe(true);
    expect(following(chainOf(MAX_FOLLOWED_CHAIN))).toEqual({
      ok: false,
      code: 'FOLLOWED_CHAIN_TOO_LONG',
    });
  });

  it('fails a stale write with the current state instead of overwriting it', () => {
    const { expected, current } = correctionAndReversal.staleWrite;
    expect(checkExpectedState(expected, current)).toEqual({
      ok: false,
      code: 'STALE_SELECTION',
      current,
    });
  });

  it('lets creation proceed with no prior token only while nothing governs the target', () => {
    const { expected, nothingGovernsYet, somethingAlreadyGoverns } = correctionAndReversal.creation;
    expect(checkExpectedState(expected, nothingGovernsYet)).toEqual({ ok: true });
    expect(checkExpectedState(expected, somethingAlreadyGoverns).ok).toBe(false);
  });

  it('refuses an observed state that names a governing record twice', () => {
    expect(
      accepts(
        ExpectedStateSchema,
        correctionAndReversal.refusedStates.observedStateNamingARecordTwice
      )
    ).toBe(false);
  });
});

describe('exact approval binding', () => {
  it('lets a plan be approved with no targets, which then authorizes no adoption', () => {
    const { planApprovedWithNoTargets } = exactApprovalBinding;
    expect(accepts(ApprovalBindingSchema, planApprovedWithNoTargets)).toBe(true);
    expect(
      selectionMatchesBinding(
        planApprovedWithNoTargets,
        authorityInTheStore.adoptionUnderTheBinding
      )
    ).toBe(false);
  });

  it('keeps a binding covered by its approval only while it is identical', () => {
    const { boundApproval, samePlanTextWithTheSameBinding } = exactApprovalBinding;
    expect(accepts(ApprovalBindingSchema, boundApproval)).toBe(true);
    expect(bindingCoveredByApproval(boundApproval, samePlanTextWithTheSameBinding)).toBe(true);
  });

  it.each(Object.entries(exactApprovalBinding.changedBindings))(
    'inherits nothing for %s',
    (_name, changed) => {
      expect(accepts(ApprovalBindingSchema, changed)).toBe(true);
      expect(bindingCoveredByApproval(exactApprovalBinding.boundApproval, changed)).toBe(false);
    }
  );

  it('gives byte-identical plan text with a changed target no inherited approval', () => {
    const { boundApproval, changedBindings } = exactApprovalBinding;
    expect(changedBindings['a changed revision'].approval).toEqual(boundApproval.approval);
    expect(bindingCoveredByApproval(boundApproval, changedBindings['a changed revision'])).toBe(
      false
    );
  });

  it('resolves an approved selector to a local identity, and again to the same one', () => {
    const { boundApproval, selectorResolvedLocally } = exactApprovalBinding;
    expect(accepts(SelectorResolutionSchema, selectorResolvedLocally.resolution)).toBe(true);
    expect(checkSelectorResolution({ binding: boundApproval, ...selectorResolvedLocally })).toEqual(
      { ok: true }
    );
  });

  it('authorizes only a resolution of the selector on the cited binding', () => {
    const { boundApproval, selectorResolvedLocally } = exactApprovalBinding;
    const resolution = selectorResolvedLocally.resolution;
    const selectorBinding = {
      ...boundApproval,
      targets: boundApproval.targets.filter((target) => target.target.kind === 'source_selector'),
    };
    const base = authorityInTheStore.covered['an adoption the binding names'];
    const check = {
      ...base,
      authorization: { kind: 'approval_binding' as const, binding_id: boundApproval.binding_id },
      scope: resolution.scope,
      footprint: {
        adopts: [{ revision: resolution.resolved, designation: resolution.designation }],
        departs_from: [],
        restates: [],
      },
      context: {
        bindings: [{ ...selectorBinding, resolved_targets: [resolution] }],
        earlier: [],
        assignments: [],
      },
    };
    expect(checkAuthorization(check)).toEqual({ ok: true });

    for (const resolved of [
      { ...resolution, binding_id: exactApprovalBinding.planApprovedWithNoTargets.binding_id },
      {
        ...resolution,
        selector: { ...resolution.selector, passage_sha256: 'c'.repeat(64) },
      },
    ])
      expect(
        checkAuthorization({
          ...check,
          context: {
            ...check.context,
            bindings: [{ ...selectorBinding, resolved_targets: [resolved] }],
          },
        })
      ).toEqual({ ok: false, code: 'BINDING_DOES_NOT_COVER_ADOPTION' });
  });

  it.each(Object.entries(exactApprovalBinding.refusedResolutions))(
    'refuses a resolution with %s',
    (_name, { code, ...refused }) => {
      expect(
        checkSelectorResolution({ binding: exactApprovalBinding.boundApproval, ...refused })
      ).toEqual({ ok: false, code });
    }
  );

  it('refuses a branch as an authority scope', () => {
    expect(
      accepts(AuthorityScopeSchema, exactApprovalBinding.refused.branchAsAnAuthorityScope)
    ).toBe(false);
  });

  it('refuses one target bound as both adopted and background in one scope', () => {
    expect(
      refusalPaths(
        ApprovalBindingSchema,
        exactApprovalBinding.refused.oneTargetBoundAsBothAdoptedAndBackground
      )
    ).toEqual(['targets']);
  });
});

describe('authority checked against the store', () => {
  it.each(Object.entries(authorityInTheStore.covered))('authorizes %s', (_name, check) => {
    expect(checkAuthorization(check)).toEqual({ ok: true });
  });

  it.each(Object.entries(authorityInTheStore.refused))('refuses %s', (_name, { check, code }) => {
    expect(checkAuthorization(check)).toEqual({ ok: false, code });
  });

  it('asks about a revision adopted beside another unless the instruction acknowledges it', () => {
    const { successorBesideTheAdoptedRevision, acknowledging } = authorityInTheStore.standingBeside;
    const { selection, adoptedBeside } = successorBesideTheAdoptedRevision;
    expect(accepts(SelectionSchema, selection)).toBe(true);
    const footprint = selectionFootprint(selection, adoptedBeside);
    expect(footprint.departs_from.map((departure) => departure.how)).toEqual(['stands_beside']);
    const check = {
      scope: selection.scope,
      footprint,
      acting: { kind: 'actor' as const, actor: owner },
      context: authorityInTheStore.context,
    };
    expect(
      checkAuthorization({ ...check, authorization: selection.authorization as Authorization })
    ).toEqual({ ok: false, code: 'RULE_NOT_ACKNOWLEDGED' });
    expect(checkAuthorization({ ...check, authorization: acknowledging })).toEqual({ ok: true });
  });

  it('retains an authorization with exactly what it authorized', () => {
    const { exceptionAuthorization, refusedRecords } = authorityInTheStore;
    expect(accepts(AuthorizationRecordSchema, exceptionAuthorization)).toBe(true);
    expect(
      accepts(AuthorizationRecordSchema, refusedRecords.anAuthorizationThatAuthorizesNothing)
    ).toBe(false);
    expect(
      refusalPaths(
        AuthorizationRecordSchema,
        refusedRecords.anAuthorizationDepartingFromARuleItNeverAcknowledged
      )
    ).toEqual(['instruction']);
    expect(
      refusalPaths(
        AuthorizationRecordSchema,
        refusedRecords.aDepartureThatExceptsWithoutNamingItsException
      )
    ).toEqual(['departs_from.0.exception_id']);
  });
});

describe('informed authorization', () => {
  it.each(Object.entries(informedAuthorization.conflicts))('%s', (_name, example) => {
    expect(conflictDisposition(example.input)).toEqual(example.disposition);
  });

  it('accepts an exception and an adoption resting on an instruction', () => {
    expect(accepts(ExceptionSchema, informedAuthorization.acceptedException)).toBe(true);
    expect(accepts(SelectionSchema, informedAuthorization.acceptedSelection)).toBe(true);
  });

  it('retains a refusal so the same question is not asked again', () => {
    expect(accepts(ConflictAnswerSchema, informedAuthorization.declinedCloudStartup)).toBe(true);
    expect(
      refusalPaths(
        ConflictAnswerSchema,
        informedAuthorization.refused.declinedAnswerNamingAnAuthorization
      )
    ).toEqual(['authorization_id']);
  });

  it('revokes on an instruction in the same scope only', () => {
    expect(accepts(RevocationSchema, informedAuthorization.revokedException)).toBe(true);
    expect(
      refusalPaths(
        RevocationSchema,
        informedAuthorization.refused.revocationOnAnInstructionFromAnotherScope
      )
    ).toEqual(['instruction']);
  });

  it('records a finished task choice without adopting anything', () => {
    expect(accepts(SelectionSchema, informedAuthorization.finishedTaskChoice)).toBe(true);
    expect(
      refusalPaths(SelectionSchema, informedAuthorization.refused.finishedTaskPresentedAsAdoption)
    ).toEqual(['designation']);
  });

  it('refuses an acceptance with no authorization, and one broader than its instruction', () => {
    const { acceptanceWithNoAuthorization, adoptionBroaderThanItsInstruction } =
      informedAuthorization.refused;
    expect(refusalPaths(SelectionSchema, acceptanceWithNoAuthorization)).toEqual(['authorization']);
    expect(refusalPaths(SelectionSchema, adoptionBroaderThanItsInstruction)).toEqual([
      'authorization',
    ]);
  });

  it('refuses an informed instruction that acknowledges no rule', () => {
    expect(
      accepts(
        AuthorizationSchema,
        informedAuthorization.refused.informedInstructionThatAcknowledgesNothing
      )
    ).toBe(false);
  });

  it('requires an edit of a promoted criterion to name its action', () => {
    const { sharedRevision, taskLocalChange } = informedAuthorization.editOfThePromotedCriterion;
    expect(accepts(PromotedCriterionEditSchema, sharedRevision)).toBe(true);
    expect(accepts(PromotedCriterionEditSchema, taskLocalChange)).toBe(true);
    expect(
      refusalPaths(
        PromotedCriterionEditSchema,
        informedAuthorization.refused.promotedCriterionEditWithNoAction
      )
    ).toEqual(['action']);
  });
});

describe('exception endings', () => {
  it('accepts an exception with an unknown end and one that expires', () => {
    expect(accepts(ExceptionSchema, exceptionEndings.accepted.cloudOnlyReportException)).toBe(true);
    expect(accepts(ExceptionSchema, exceptionEndings.accepted.untilNextRelease)).toBe(true);
  });

  it.each(Object.entries(exceptionEndings.standing))('%s', (_name, example) => {
    expect(exceptionStanding(example.exception, example.at)).toBe(example.standing);
  });

  it.each(Object.entries(exceptionEndings.refused))('refuses %s', (_name, refused) => {
    expect(refusalPaths(ExceptionSchema, refused.exception)).toEqual(refused.paths);
  });
});

describe('applicability', () => {
  it.each(Object.entries(applicabilityLookup))('%s', (_name, example) => {
    expect(evaluateApplicability(example.selector, example.inputs)).toBe(example.applicability);
  });
});

describe('relationships', () => {
  it('refers to a relationship as its own revision', () => {
    expect(accepts(RecordRevisionRefSchema, relationshipReference.accepted)).toBe(true);
    expect(
      refusalPaths(RecordRevisionRefSchema, relationshipReference.refusedWithARevisionOfItsOwn)
    ).toEqual(['revision_id']);
  });

  it('lets an actor with authority establish a replacement and a detector suggest a dependency', () => {
    expect(accepts(RelationshipSchema, relationships.establishedReplacement)).toBe(true);
    expect(accepts(RelationshipSchema, relationships.suggestedDependency)).toBe(true);
    expect(relationshipFootprint(relationships.establishedReplacement).departs_from).toEqual([
      {
        rule: relationships.establishedReplacement.to,
        how: 'replaces',
        exception_id: null,
        replaced_by: relationships.establishedReplacement.from,
      },
    ]);
    expect(relationshipFootprint(relationships.suggestedDependency).departs_from).toEqual([]);
  });

  it.each(Object.entries(relationships.refused))('refuses %s', (_name, refused) => {
    expect(refusalPaths(RelationshipSchema, refused.relationship)).toEqual(refused.paths);
  });

  it('refuses a replacement that closes a loop and allows one that extends the chain', () => {
    const { existing, closesALoop, extendsTheChain } = relationships.cycles;
    expect(introducesReplacementCycle(existing, closesALoop)).toBe(true);
    expect(introducesReplacementCycle(existing, extendsTheChain)).toBe(false);
  });

  it('counts only replacements towards a replacement cycle', () => {
    const { existing, closesALoop, aDependencyThatPointsBack } = relationships.cycles;
    expect(introducesReplacementCycle(existing, aDependencyThatPointsBack)).toBe(false);
    expect(introducesReplacementCycle([aDependencyThatPointsBack], closesALoop)).toBe(false);
  });

  it('terminates on imported history that already contains a cycle', () => {
    const { importedHistoryAlreadyCyclic, extendsTheChain } = relationships.cycles;
    expect(introducesReplacementCycle(importedHistoryAlreadyCyclic, extendsTheChain)).toBe(false);
  });
});

describe('evidence and assessment', () => {
  it('records an execution that consumed identified inputs as snapshot bound', () => {
    expect(accepts(ObservationSchema, evidenceAndAssessment.offlineSmokeRun)).toBe(true);
  });

  it('concludes about identified software, and only looks up expectations when none is selected', () => {
    expect(accepts(AssessmentSchema, evidenceAndAssessment.assessmentOfTheRelease)).toBe(true);
    expect(accepts(AssessmentSchema, evidenceAndAssessment.lookupBeforeAnyCode)).toBe(true);
  });

  it.each(Object.entries(evidenceAndAssessment.refused))('refuses %s', (_name, refused) => {
    const schema = refused.schema === 'observation' ? ObservationSchema : AssessmentSchema;
    expect(refusalPaths(schema, refused.input)).toEqual(refused.paths);
  });
});

describe('delegation', () => {
  it('accepts an assignment inside its instruction and refuses one broader than it', () => {
    expect(accepts(AssignmentSchema, delegation.retryAssignment)).toBe(true);
    const { refused } = delegation;
    expect(refusalPaths(AssignmentSchema, refused.assignmentBroaderThanItsInstruction)).toEqual([
      'authorization',
    ]);
    expect(
      refusalPaths(
        AssignmentSchema,
        refused.assignmentDepartingFromARuleItsInstructionNeverAcknowledged
      )
    ).toEqual(['authorization']);
    expect(
      refusalPaths(AssignmentSchema, refused.assignmentRestingOnAnAuthorizationGivenForOneAct)
    ).toEqual(['authorization']);
    expect(refusalPaths(AssignmentSchema, refused.assignmentWithNobodyResponsible)).toEqual([
      'responsible',
    ]);
  });

  it.each(Object.entries(delegation.covered))('covers %s', (_name, check) => {
    expect(checkAuthorization(check)).toEqual({ ok: true });
  });

  it.each(Object.entries(delegation.refusedAuthority))('refuses %s', (_name, { check, code }) => {
    expect(checkAuthorization(check)).toEqual({ ok: false, code });
  });

  it.each(Object.entries(delegation.conflicts))('%s', (_name, example) => {
    expect(conflictDisposition(example.input)).toEqual(example.disposition);
  });
});

describe('a requirement followed end to end', () => {
  const followed = requirementFollowedEndToEnd;

  it('starts from one capture, one identity and one revision', () => {
    expect(accepts(SourceOccurrenceSchema, followed.capture)).toBe(true);
    expect(accepts(RequirementIdentitySchema, followed.identity)).toBe(true);
    expect(accepts(RequirementRevisionSchema, followed.revision)).toBe(true);
    expect(accepts(TaskUseSchema, followed.use)).toBe(true);
    expect(followed.identity.requirement_id).toBe(followed.requirement_id);
    expect(followed.revision.source_ids).toContain(followed.capture.source_id);
    expect(followed.use.target.entity_id).toBe(followed.requirement_id);
    expect(followed.use.target.revision_id).toBe(followed.revision.revision_id);
  });

  it('passes the stale-state and authority checks at every step, in order', () => {
    let governing: Required<GoverningState> = { selection_ids: [], correction_action_ids: [] };
    for (const step of followed.steps) {
      const { record } = step;
      expect(checkExpectedState(record.expected_state, governing), step.name).toEqual({ ok: true });
      if ('selection_id' in record) {
        expect(refusalPaths(SelectionSchema, record), step.name).toBeNull();
        expect(
          checkAuthorization({
            authorization: record.authorization as Authorization,
            scope: record.scope,
            footprint: selectionFootprint(record, []),
            acting: { kind: 'actor' as const, actor: record.selected_by },
            context: followed.authorizationContext,
          }),
          step.name
        ).toEqual({ ok: true });
      } else {
        expect(refusalPaths(CorrectionActionSchema, record), step.name).toBeNull();
        expect(judged({ action: record, followed: null }).ok, step.name).toBe(true);
      }
      // A replacement makes its successor stand in place of the revision every
      // selection here adopted, so those selections stop standing with it: what
      // governs is the selections that stand, not every one ever recorded.
      const replaces = !('selection_id' in record) && record.kind === 'accepted_replacement';
      governing = {
        selection_ids: replaces
          ? []
          : [...governing.selection_ids, ...(step.governs.selection_ids ?? [])],
        correction_action_ids: [
          ...governing.correction_action_ids,
          ...(step.governs.correction_action_ids ?? []),
        ],
      };
    }
    const replacement = followed.steps[2]?.record as CorrectionAction;
    expect(governing).toEqual({
      selection_ids: [],
      correction_action_ids: [replacement.action_id],
    });
  });

  it('names the one identity at every step and assesses the revision that stands at the end', () => {
    const touched = followed.steps.flatMap(({ record }) =>
      'selection_id' in record ? [record.target] : record.targets
    );
    expect(new Set(touched.map((revision) => revision.entity_id))).toEqual(
      new Set([followed.requirement_id])
    );
    const replacement = followed.steps[2]?.record as Extract<
      CorrectionAction,
      { kind: 'accepted_replacement' }
    >;
    expect(replacement.replacement).toEqual(followed.standsAtTheEnd);
    expect(accepts(AssessmentSchema, followed.assessment)).toBe(true);
    expect(followed.assessment.expectations).toEqual([followed.standsAtTheEnd]);
  });

  it('would refuse the replacement under the first approval, which never mentioned a departure', () => {
    const replacement = followed.steps[2]?.record as CorrectionAction;
    expect(
      judged({
        action: {
          ...replacement,
          authorization: { kind: 'approval_binding', binding_id: followed.approval.binding_id },
        },
        followed: null,
      })
    ).toEqual({ ok: false, code: 'BINDING_DOES_NOT_COVER_ADOPTION' });
  });

  it('gives an exception a footprint that excepts its expectation, by name, and adopts nothing', () => {
    const exception = informedAuthorization.acceptedException;
    expect(exceptionFootprint(exception)).toEqual({
      adopts: [],
      departs_from: [
        {
          rule: exception.expectation,
          how: 'excepts',
          exception_id: exception.exception_id,
          replaced_by: null,
        },
      ],
      restates: [],
    });
  });
});

describe('processing admission', () => {
  it.each(processingAdmission)('$name', ({ input, admits }) => {
    expect(admitsProcessingJob(input)).toBe(admits);
  });
});
