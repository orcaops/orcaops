import { describe, expect, it } from 'vitest';

import {
  type Assignment,
  type AuthorityScope,
  type CorrectionAction,
  CorrectionActionSchema,
  ExceptionSchema,
  type ExpectationRevisionRef,
  type FollowedCorrection,
  type KnowledgeException,
  type RecordRevisionRef,
  type Relationship,
  RelationshipSchema,
  type RelationshipTarget,
  type Revocation,
  RevocationSchema,
  type Selection,
  SelectionSchema,
} from './knowledge-contract.js';
import {
  governingStateOf,
  type KnowledgeReadRequest,
  type KnowledgeRecords,
  type KnowledgeRevision,
  type KnowledgeTarget,
  type PublishedAct,
  type PublishedRecord,
  resolveKnowledge,
  type RevisionStanding,
} from './knowledge-resolution.js';
import {
  applicabilityLookup,
  correctionAndReversal,
  exceptionEndings,
  informedAuthorization,
  requirementFollowedEndToEnd,
  siblingRevisions,
} from '../../tests/knowledge-contract-examples.js';

const id = (n: number) => `01a0c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const projectScope = informedAuthorization.acceptedSelection.scope;
const artifactScope = informedAuthorization.finishedTaskChoice.scope;
const otherArtifactScope: AuthorityScope = {
  kind: 'artifact',
  artifact_id: '01a0c000-0000-7000-8000-000000000003',
};
const owner = informedAuthorization.acceptedSelection.selected_by;
const detector = { kind: 'detector' as const, detector: 'knowledge-processor' };

const firstRevision = requirementFollowedEndToEnd.use.target;
const laterRevision = requirementFollowedEndToEnd.standsAtTheEnd;
const requirementIdentity: KnowledgeTarget = {
  kind: firstRevision.kind,
  entity_id: firstRevision.entity_id,
};

type Instruction = Revocation['instruction'];

const instructionIn = (scope: AuthorityScope): Instruction => ({
  kind: 'explicit_instruction',
  instruction_source_id: id(1),
  scope,
});

const acknowledging = (
  acknowledged: readonly ExpectationRevisionRef[],
  scope: AuthorityScope = projectScope
): Instruction => ({
  kind: 'informed_instruction',
  instruction_source_id: id(1),
  acknowledged: [...acknowledged],
  scope,
});

const at = <T>(write_sequence: number, record: T): PublishedRecord<T> => ({
  write_sequence,
  record,
});

const published = <T>(
  write_sequence: number,
  record: T,
  authorization_id: string | null = null
): PublishedAct<T> => ({ write_sequence, record, authorization_id });

const nothing = (target: KnowledgeTarget): KnowledgeRecords => ({
  target,
  replacement_graph_complete: true,
  revisions: [],
  selections: [],
  corrections: [],
  relationships: [],
  exceptions: [],
  revocations: [],
  conflict_answers: [],
  branch_scoped_rows: [],
});

const holding = (target: KnowledgeTarget, held: Partial<KnowledgeRecords>): KnowledgeRecords => ({
  ...nothing(target),
  ...held,
});

const reading = (
  knowledge_boundary: number,
  change: Partial<KnowledgeReadRequest> = {}
): KnowledgeReadRequest => ({
  scope: projectScope,
  mode: 'current',
  knowledge_boundary,
  implementation: { kind: 'none_selected' },
  applicability: {},
  exceptions_judged_at: null,
  exception_conditions: {},
  ...change,
});

const adopting = (
  selection_id: string,
  target: RecordRevisionRef,
  change: Partial<Selection> = {}
): Selection => ({
  selection_id,
  kind: 'accepted',
  target,
  scope: projectScope,
  designation: 'adopted',
  selected_by: owner,
  authorization: instructionIn(change.scope ?? projectScope),
  expected_state: { kind: 'initial' },
  ...change,
});

const withdrawing = (
  action_id: string,
  targets: readonly RecordRevisionRef[],
  change: Partial<Extract<CorrectionAction, { kind: 'withdrawal' }>> = {}
): CorrectionAction => ({
  action_id,
  kind: 'withdrawal',
  targets: [...targets],
  scope: projectScope,
  attributed_to: { kind: 'actor', actor: owner },
  source_id: id(2),
  authorization: acknowledging(targets.filter(isExpectation)),
  expected_state: { kind: 'initial' },
  reason: 'The promise was retired.',
  ...change,
});

function isExpectation(ref: RecordRevisionRef): ref is ExpectationRevisionRef {
  return ref.kind === 'requirement' || ref.kind === 'decision';
}

const replacing = (
  action_id: string,
  targets: readonly RecordRevisionRef[],
  replacement: RecordRevisionRef,
  change: Partial<Extract<CorrectionAction, { kind: 'accepted_replacement' }>> = {}
): CorrectionAction => ({
  action_id,
  kind: 'accepted_replacement',
  targets: [...targets],
  replacement,
  designation: 'adopted',
  scope: projectScope,
  attributed_to: { kind: 'actor', actor: owner },
  source_id: id(2),
  authorization: acknowledging(targets.filter(isExpectation), change.scope ?? projectScope),
  expected_state: { kind: 'initial' },
  ...change,
});

const reversing = (
  action_id: string,
  reverses: CorrectionAction,
  resulting_selection: Extract<CorrectionAction, { kind: 'reversal' }>['resulting_selection'],
  change: Partial<Extract<CorrectionAction, { kind: 'reversal' }>> = {}
): CorrectionAction =>
  CorrectionActionSchema.parse({
    action_id,
    kind: 'reversal',
    targets: [...reverses.targets],
    reverses_action_id: reverses.action_id,
    resulting_selection,
    scope: projectScope,
    attributed_to: { kind: 'actor', actor: owner },
    source_id: id(2),
    authorization: acknowledging([firstRevision], change.scope ?? projectScope),
    expected_state: { kind: 'initial' },
    ...change,
  });

const relationshipRef = (entity_id: string): RecordRevisionRef => ({
  kind: 'relationship',
  entity_id,
  revision_id: entity_id,
});

const replacementEdge = (
  relationship_id: string,
  from: RecordRevisionRef,
  to: RecordRevisionRef,
  change: Partial<Relationship> = {}
): Relationship =>
  RelationshipSchema.parse({
    relationship_id,
    relation: 'supersedes',
    from,
    to,
    scope: projectScope,
    standing: 'established',
    attributed_to: { kind: 'actor', actor: owner },
    authorization: acknowledging([to as ExpectationRevisionRef], change.scope ?? projectScope),
    source_ids: [id(3)],
    explanation: 'The successor replaced it after review.',
    ...change,
  });

const knowledgeRevision = (
  revision: RecordRevisionRef,
  change: Partial<KnowledgeRevision> = {}
): KnowledgeRevision => ({
  revision,
  applicability: { all_of: [] },
  source_standing: 'explicit_instruction',
  attributed_to: { kind: 'actor', actor: owner },
  ...change,
});

const standingOf = (entries: readonly RevisionStanding[], revision: RecordRevisionRef) =>
  entries.filter(
    (entry) =>
      entry.revision.revision_id === revision.revision_id &&
      entry.revision.entity_id === revision.entity_id
  );

const bothRevisions = [
  at(1, knowledgeRevision(firstRevision)),
  at(1, knowledgeRevision(laterRevision)),
];

describe('a requirement followed end to end', () => {
  const [adoption, challenge, replacement] = requirementFollowedEndToEnd.steps.map(
    (step) => step.record
  );
  const records = holding(requirementIdentity, {
    revisions: bothRevisions,
    selections: [published(1, adoption as Selection)],
    corrections: [
      published(2, challenge as CorrectionAction),
      published(3, replacement as CorrectionAction),
    ],
  });

  it('governs by the approval that adopted the first revision', () => {
    const answer = resolveKnowledge(records, reading(1));
    expect(answer.governing_state).toEqual({
      selection_ids: [(adoption as Selection).selection_id],
      correction_action_ids: [],
    });
    expect(standingOf(answer.revisions, firstRevision)).toEqual([
      expect.objectContaining({
        standing: 'stands',
        scope: projectScope,
        designation: 'adopted',
        applicability: 'applies',
        stood_by: [(adoption as Selection).selection_id],
      }),
    ]);
  });

  it('keeps a challenge out of the governing state so it cannot make a write stale', () => {
    const answer = resolveKnowledge(records, reading(2));
    const challenged = challenge as CorrectionAction;
    expect(answer.governing_state.correction_action_ids).toEqual([]);
    expect(answer.proposals).toEqual([
      expect.objectContaining({ action_id: challenged.action_id, kind: 'challenge' }),
    ]);
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({
      standing: 'stands',
      challenged_by: [],
    });
  });

  it('stands the successor on the replacement and stops the revision it replaced', () => {
    const answer = resolveKnowledge(records, reading(3));
    const replaced = replacement as CorrectionAction;
    expect(answer.governing_state).toEqual({
      selection_ids: [],
      correction_action_ids: [replaced.action_id],
    });
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({
      standing: 'stopped',
      because: [
        { record: 'selection', record_id: (adoption as Selection).selection_id, effect: 'adopted' },
        { record: 'correction', record_id: replaced.action_id, effect: 'replaced' },
      ],
    });
    expect(standingOf(answer.revisions, laterRevision)[0]).toMatchObject({
      standing: 'stands',
      designation: 'adopted',
      stood_by: [],
    });
  });

  it('answers at a boundary that falls between an adoption and what follows it', () => {
    const answer = resolveKnowledge(records, reading(1));
    const challenged = challenge as CorrectionAction;
    expect(answer.later_annotations).toEqual([
      {
        record: 'correction',
        record_id: challenged.action_id,
        write_sequence: 2,
        correction: { kind: 'challenge', targets: challenged.targets },
        recorded_at: null,
      },
      {
        record: 'correction',
        record_id: (replacement as CorrectionAction).action_id,
        write_sequence: 3,
        correction: { kind: 'accepted_replacement', targets: [firstRevision] },
        recorded_at: null,
      },
    ]);
    expect(answer.proposals).toEqual([]);
  });
});

const relationshipFrom = (target: RelationshipTarget): Relationship =>
  RelationshipSchema.parse({
    relationship_id: target.relationship_id,
    relation: target.relation,
    from: target.from,
    to: target.to,
    scope: projectScope,
    standing: target.standing,
    attributed_to: target.attributed_to,
    authorization:
      target.standing === 'established' && target.relation === 'supersedes'
        ? acknowledging([target.to as ExpectationRevisionRef])
        : null,
    source_ids: [id(3)],
    explanation: 'The store knows this relationship.',
  });

const chainOf = (followed: FollowedCorrection | null): CorrectionAction[] =>
  followed === null ? [] : [...chainOf(followed.followed), followed.action];

type AcceptedCorrection =
  (typeof correctionAndReversal.accepted)[keyof typeof correctionAndReversal.accepted];

const replay = (example: AcceptedCorrection) => {
  const actions = [...chainOf(example.followed), example.action];
  const target = example.action.targets[0] as RecordRevisionRef;
  return resolveKnowledge(
    holding(
      { kind: target.kind, entity_id: target.entity_id },
      {
        corrections: actions.map((action, index) => published(index + 1, action)),
        relationships: (example.relationship_targets ?? []).map((known) =>
          published(0, relationshipFrom(known))
        ),
      }
    ),
    reading(actions.length, { scope: example.action.scope })
  );
};

const changesWhatStands = (footprint: AcceptedCorrection['footprint']) =>
  (footprint.adopts ?? 0) > 0 ||
  (footprint.departs ?? []).length > 0 ||
  (footprint.restates ?? 0) > 0;

describe('the corrections and reversals the contract accepts', () => {
  it.each(Object.entries(correctionAndReversal.accepted))(
    'governs after %s exactly when it changed what stands',
    (_name, example) => {
      const answer = replay(example);
      expect(answer.governing_state.correction_action_ids.includes(example.action.action_id)).toBe(
        changesWhatStands(example.footprint)
      );
    }
  );

  it('shows an accepted challenge on the revision and leaves it standing', () => {
    const example = correctionAndReversal.accepted['an accepted challenge to a requirement'];
    const challenge = chainOf(example.followed)[0] as CorrectionAction;
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(1, adopting(id(10), firstRevision))],
        corrections: [published(2, challenge), published(3, example.action)],
      }),
      reading(3)
    );
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({
      standing: 'stands',
      challenged_by: [{ action_id: challenge.action_id, accepted_by: example.action.action_id }],
    });
    expect(answer.governing_state.correction_action_ids).toEqual([example.action.action_id]);
    expect(answer.proposals[0]).toMatchObject({
      action_id: challenge.action_id,
      accepted_by: example.action.action_id,
      retracted_by: null,
    });
  });

  it('shows a use correction as a corrected basis without letting it govern', () => {
    const example = correctionAndReversal.accepted['a correction of how a task used a requirement'];
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(1, adopting(id(10), firstRevision))],
        corrections: [published(2, example.action)],
      }),
      reading(2)
    );
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({
      standing: 'stands',
      corrected_basis: [{ action_id: example.action.action_id, accepted_by: null }],
    });
    expect(answer.governing_state.correction_action_ids).toEqual([]);
  });
});

describe('what stands', () => {
  it('keeps two adopted revisions of one identity as a conflict, whichever came last', () => {
    const [tighter, looser] = siblingRevisions.tipsAfterBoth.map((revision_id) => ({
      ...firstRevision,
      revision_id,
    }));
    const records = holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(tighter)), at(1, knowledgeRevision(looser))],
      selections: [
        published(2, adopting(id(10), tighter)),
        published(
          3,
          adopting(id(11), looser, {
            selected_by: { identity: 'other@example.test', basis: 'authenticated' },
          })
        ),
      ],
    });
    const answer = resolveKnowledge(records, reading(3));
    expect(answer.revisions.map((entry) => entry.standing)).toEqual(['stands', 'stands']);
    expect(answer.governing_state.selection_ids).toEqual([id(10), id(11)]);
    expect(answer.conflicts).toEqual([
      {
        scope: projectScope,
        revisions: [tighter, looser],
        disposition: expect.objectContaining({ action: 'ask_once' }),
      },
    ]);
  });

  it('takes the designation from the later act on the same revision in one scope', () => {
    const records = holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(firstRevision))],
      selections: [
        published(2, adopting(id(10), firstRevision)),
        published(3, adopting(id(11), firstRevision, { designation: 'background' })),
      ],
    });
    const answer = resolveKnowledge(records, reading(3));
    expect(answer.revisions[0]).toMatchObject({
      standing: 'stands',
      designation: 'background',
      stood_by: [id(11)],
      because: [
        { record: 'selection', record_id: id(10), effect: 'adopted' },
        { record: 'selection', record_id: id(11), effect: 'designation_changed' },
      ],
    });
    expect(answer.governing_state.selection_ids).toEqual([id(11)]);
    expect(answer.conflicts).toEqual([]);
  });

  it('lets a revision be adopted again after it was withdrawn', () => {
    const records = holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(firstRevision))],
      selections: [
        published(2, adopting(id(10), firstRevision)),
        published(4, adopting(id(11), firstRevision)),
      ],
      corrections: [published(3, withdrawing(id(12), [firstRevision]))],
    });
    expect(resolveKnowledge(records, reading(3)).revisions[0]).toMatchObject({
      standing: 'stopped',
      stood_by: [],
    });
    const answer = resolveKnowledge(records, reading(4));
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands', stood_by: [id(11)] });
    expect(answer.governing_state).toEqual({
      selection_ids: [id(11)],
      correction_action_ids: [id(12)],
    });
    expect(answer.correction_effects).toEqual([{ action_id: id(12), standing: 'ended' }]);
  });

  it('keeps a correction effective while any target still carries its effect', () => {
    const withdrawal = withdrawing(id(12), [firstRevision, laterRevision]);
    const records = holding(requirementIdentity, {
      revisions: bothRevisions,
      selections: [
        published(1, adopting(id(10), firstRevision)),
        published(2, adopting(id(11), laterRevision)),
        published(4, adopting(id(13), firstRevision)),
        published(5, adopting(id(14), laterRevision)),
      ],
      corrections: [published(3, withdrawal)],
    });

    expect(resolveKnowledge(records, reading(4)).correction_effects).toEqual([
      { action_id: withdrawal.action_id, standing: 'effective' },
    ]);
    expect(resolveKnowledge(records, reading(5)).correction_effects).toEqual([
      { action_id: withdrawal.action_id, standing: 'ended' },
    ]);
  });

  it('leaves acts on an unavailable revision unresolved instead of calling them ended', () => {
    const unknown = { ...firstRevision, revision_id: id(99) };
    const selection = adopting(id(10), unknown);
    const withdrawal = withdrawing(id(12), [unknown]);
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        selections: [published(1, selection), published(3, adopting(id(11), unknown))],
        corrections: [published(2, withdrawal)],
      }),
      reading(3)
    );

    expect(answer.selection_effects).toEqual([
      { selection_id: id(10), standing: 'unresolved' },
      { selection_id: id(11), standing: 'unresolved' },
    ]);
    expect(answer.correction_effects).toEqual([
      { action_id: withdrawal.action_id, standing: 'unresolved' },
    ]);
  });

  it('stops a revision standing while an established replacement points at it', () => {
    const replacement = RelationshipSchema.parse({
      relationship_id: id(20),
      relation: 'supersedes',
      from: laterRevision,
      to: firstRevision,
      scope: projectScope,
      standing: 'established',
      attributed_to: { kind: 'actor', actor: owner },
      authorization: acknowledging([firstRevision]),
      source_ids: [id(3)],
      explanation: 'The successor replaced it after review.',
    });
    const records = holding(requirementIdentity, {
      revisions: bothRevisions,
      selections: [published(2, adopting(id(10), firstRevision))],
      relationships: [published(3, replacement)],
    });
    const answer = resolveKnowledge(records, reading(3));
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({
      standing: 'stopped',
      because: [
        { record: 'selection', record_id: id(10), effect: 'adopted' },
        { record: 'relationship', record_id: id(20), effect: 'superseded_by_relationship' },
      ],
    });
    expect(answer.relationships[0]).toMatchObject({ standing: 'established' });
    expect(answer.governing_state.selection_ids).toEqual([]);
  });

  it('reports a working choice apart from adoptions, adopting nothing', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, informedAuthorization.finishedTaskChoice)],
      }),
      reading(2, { scope: artifactScope })
    );
    expect(answer.recorded_choices).toEqual([
      expect.objectContaining({
        selection_id: informedAuthorization.finishedTaskChoice.selection_id,
        kind: 'final_recorded',
      }),
    ]);
    expect(answer.governing_state).toEqual({ selection_ids: [], correction_action_ids: [] });
    expect(answer.revisions[0]).toMatchObject({ standing: 'unadopted', scope: null });
  });

  it('keeps a candidate a detector extracted out of what stands', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [
          at(
            1,
            knowledgeRevision(laterRevision, {
              source_standing: 'extracted_candidate',
              attributed_to: detector,
            })
          ),
        ],
      }),
      reading(1)
    );
    expect(answer.revisions[0]).toMatchObject({
      standing: 'unadopted',
      designation: null,
      source_standing: 'extracted_candidate',
      attributed_to: detector,
    });
  });
});

describe('scope', () => {
  const artifactAdoption = adopting(id(11), laterRevision, {
    scope: artifactScope,
    authorization: instructionIn(artifactScope),
  });
  const records = holding(requirementIdentity, {
    revisions: bothRevisions,
    selections: [published(2, adopting(id(10), firstRevision)), published(3, artifactAdoption)],
  });

  it('applies a project adoption in the artifact, beside the artifact of its own', () => {
    const answer = resolveKnowledge(records, reading(3, { scope: artifactScope }));
    expect(answer.governing_state.selection_ids).toEqual([id(10), id(11)]);
    expect(answer.conflicts).toEqual([
      { scope: null, revisions: [firstRevision, laterRevision], disposition: expect.anything() },
    ]);
  });

  it('leaves an artifact adoption out of the project answer', () => {
    const answer = resolveKnowledge(records, reading(3));
    expect(answer.governing_state.selection_ids).toEqual([id(10)]);
    expect(answer.omissions).toEqual([
      { record: 'selection', record_id: id(11), reason: 'another_scope' },
    ]);
    expect(answer.conflicts).toEqual([]);
  });

  it('leaves an artifact-scoped withdrawal out of the project answer', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [
          published(
            3,
            withdrawing(id(12), [firstRevision], {
              scope: artifactScope,
              authorization: acknowledging([firstRevision], artifactScope),
            })
          ),
        ],
      }),
      reading(3)
    );
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands' });
    expect(answer.omissions).toEqual([
      { record: 'correction', record_id: id(12), reason: 'another_scope' },
    ]);
  });
});

describe('the knowledge boundary', () => {
  const records = holding(requirementIdentity, {
    revisions: [at(1, knowledgeRevision(firstRevision))],
    selections: [published(2, adopting(id(10), firstRevision))],
    corrections: [published(4, withdrawing(id(12), [firstRevision]))],
  });

  it('answers at a boundary that falls between an adoption and its withdrawal', () => {
    const answer = resolveKnowledge(records, reading(3, { mode: 'historical' }));
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands', stood_by: [id(10)] });
    expect(answer.governing_state).toEqual({
      selection_ids: [id(10)],
      correction_action_ids: [],
    });
  });

  it('returns a correction published after the boundary as a later annotation only', () => {
    const answer = resolveKnowledge(records, reading(3, { mode: 'historical' }));
    expect(answer.later_annotations).toEqual([
      {
        record: 'correction',
        record_id: id(12),
        write_sequence: 4,
        correction: { kind: 'withdrawal', targets: [firstRevision] },
        recorded_at: null,
      },
    ]);
    expect(answer.governing_state.correction_action_ids).toEqual([]);
    expect(resolveKnowledge(records, reading(4)).governing_state.correction_action_ids).toEqual([
      id(12),
    ]);
  });

  it("keeps a detector's challenge between two authorized writes out of the basis", () => {
    const challenge = CorrectionActionSchema.parse({
      action_id: id(13),
      kind: 'challenge',
      targets: [firstRevision],
      scope: projectScope,
      attributed_to: detector,
      source_id: id(2),
      authorization: null,
      expected_state: { kind: 'observed', selection_ids: [id(10)], correction_action_ids: [] },
      explanation: 'A later summary describes a Cloud-only startup path.',
    });
    const withDetector = holding(requirementIdentity, {
      revisions: bothRevisions,
      selections: [
        published(2, adopting(id(10), firstRevision)),
        published(4, adopting(id(11), laterRevision)),
      ],
      corrections: [published(3, challenge)],
    });
    const before = resolveKnowledge(withDetector, reading(2)).governing_state;
    const after = resolveKnowledge(withDetector, reading(3)).governing_state;
    expect(after).toEqual(before);
    expect(resolveKnowledge(withDetector, reading(3)).proposals[0]).toMatchObject({
      action_id: id(13),
      attributed_to: detector,
    });
  });
});

describe('reversals', () => {
  const withdrawal = withdrawing(id(12), [firstRevision]);
  const reversalOf = (
    action_id: string,
    reverses: CorrectionAction,
    resulting: Extract<CorrectionAction, { kind: 'reversal' }>['resulting_selection']
  ): CorrectionAction =>
    CorrectionActionSchema.parse({
      action_id,
      kind: 'reversal',
      targets: reverses.targets,
      scope: projectScope,
      attributed_to: { kind: 'actor', actor: owner },
      source_id: id(2),
      authorization: acknowledging([firstRevision]),
      expected_state: { kind: 'initial' },
      reverses_action_id: reverses.action_id,
      resulting_selection: resulting,
    });

  it('restores only the selection a reversal names', () => {
    const restoring = reversalOf(id(14), withdrawal, {
      kind: 'revision',
      revision: firstRevision,
      designation: 'adopted',
    });
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [published(3, withdrawal), published(4, restoring)],
      }),
      reading(4)
    );
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands', designation: 'adopted' });
    expect(answer.governing_state).toEqual({
      selection_ids: [],
      correction_action_ids: [id(12), id(14)],
    });
    expect(answer.correction_effects).toEqual([
      { action_id: id(12), standing: 'ended' },
      { action_id: id(14), standing: 'effective' },
    ]);
  });

  it('ends a replacement when its reversal restores the earlier revision', () => {
    const replacement = replacing(id(12), [firstRevision], laterRevision);
    const reversal = reversalOf(id(14), replacement, {
      kind: 'revision',
      revision: firstRevision,
      designation: 'adopted',
    });
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(1, adopting(id(10), firstRevision))],
        corrections: [published(2, replacement), published(3, reversal)],
      }),
      reading(3)
    );

    expect(answer.correction_effects).toEqual([
      { action_id: replacement.action_id, standing: 'ended' },
      { action_id: reversal.action_id, standing: 'effective' },
    ]);
  });

  it('restores nothing when a reversal of a reversal names no selection', () => {
    const restoring = reversalOf(id(14), withdrawal, {
      kind: 'revision',
      revision: firstRevision,
      designation: 'adopted',
    });
    const undoing = reversalOf(id(15), restoring, { kind: 'none' });
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [published(3, withdrawal), published(4, restoring), published(5, undoing)],
      }),
      reading(5)
    );
    expect(answer.revisions[0]).toMatchObject({ standing: 'stopped' });
    expect(answer.revisions[0]?.because.at(-1)).toEqual({
      record: 'correction',
      record_id: id(15),
      effect: 'reversed',
    });
    expect(answer.correction_effects).toEqual([
      { action_id: id(12), standing: 'ended' },
      { action_id: id(14), standing: 'ended' },
      { action_id: id(15), standing: 'effective' },
    ]);
  });

  it('ends an acceptance when its reversal makes the proposal pending again', () => {
    const example = correctionAndReversal.accepted['an accepted challenge to a requirement'];
    const proposal = chainOf(example.followed)[0] as CorrectionAction;
    const acceptance = example.action;
    const reversal = reversalOf(id(16), acceptance, { kind: 'none' });
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        corrections: [published(2, proposal), published(3, acceptance), published(4, reversal)],
      }),
      reading(4)
    );

    expect(answer.correction_effects).toEqual([
      { action_id: proposal.action_id, standing: 'effective' },
      { action_id: acceptance.action_id, standing: 'ended' },
      { action_id: reversal.action_id, standing: 'effective' },
    ]);
    expect(answer.proposals[0]).toMatchObject({ accepted_by: null, retracted_by: null });
  });

  it('alternates a proposal between pending and retracted through repeated reversals', () => {
    const example = correctionAndReversal.accepted['an accepted challenge to a requirement'];
    const proposal = chainOf(example.followed)[0] as CorrectionAction;
    const retraction = reversalOf(id(16), proposal, { kind: 'none' });
    const restoration = reversalOf(id(17), retraction, { kind: 'none' });
    const secondRetraction = reversalOf(id(18), restoration, { kind: 'none' });
    const records = holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(firstRevision))],
      corrections: [
        published(2, proposal),
        published(3, retraction),
        published(4, restoration),
        published(5, secondRetraction),
      ],
    });

    const restored = resolveKnowledge(records, reading(4));
    expect(restored.proposals[0]).toMatchObject({ accepted_by: null, retracted_by: null });
    expect(restored.correction_effects).toEqual([
      { action_id: proposal.action_id, standing: 'effective' },
      { action_id: retraction.action_id, standing: 'ended' },
      { action_id: restoration.action_id, standing: 'effective' },
    ]);

    const retracted = resolveKnowledge(records, reading(5));
    expect(retracted.proposals[0]).toMatchObject({
      accepted_by: null,
      retracted_by: retraction.action_id,
    });
    expect(retracted.correction_effects).toEqual([
      { action_id: proposal.action_id, standing: 'ended' },
      { action_id: retraction.action_id, standing: 'effective' },
      { action_id: restoration.action_id, standing: 'ended' },
      { action_id: secondRetraction.action_id, standing: 'effective' },
    ]);
  });

  it('does not let an unresolved reversal end an accepted correction', () => {
    const example = correctionAndReversal.accepted['an accepted challenge to a requirement'];
    const proposal = chainOf(example.followed)[0] as CorrectionAction;
    const acceptance = example.action;
    const unresolved = {
      ...reversalOf(id(16), acceptance, { kind: 'none' }),
      attributed_to: detector,
    } as CorrectionAction;
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        corrections: [published(2, proposal), published(3, acceptance), published(4, unresolved)],
      }),
      reading(4)
    );

    expect(answer.revisions[0]?.challenged_by).toEqual([
      { action_id: proposal.action_id, accepted_by: acceptance.action_id },
    ]);
    expect(answer.correction_effects).toEqual([
      { action_id: proposal.action_id, standing: 'effective' },
      { action_id: acceptance.action_id, standing: 'effective' },
      { action_id: unresolved.action_id, standing: 'unresolved' },
    ]);
  });

  it('does not let acts from another scope change proposal effects', () => {
    const example = correctionAndReversal.accepted['an accepted challenge to a requirement'];
    const proposal = chainOf(example.followed)[0] as CorrectionAction;
    const acceptance = example.action;
    const outOfScopeReversal = reversing(
      id(16),
      acceptance,
      { kind: 'none' },
      {
        scope: otherArtifactScope,
      }
    );
    const accepted = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        corrections: [
          published(2, proposal),
          published(3, acceptance),
          published(4, outOfScopeReversal),
        ],
      }),
      reading(4)
    );
    expect(accepted.revisions[0]?.challenged_by).toEqual([
      { action_id: proposal.action_id, accepted_by: acceptance.action_id },
    ]);
    expect(accepted.correction_effects).toEqual([
      { action_id: proposal.action_id, standing: 'effective' },
      { action_id: acceptance.action_id, standing: 'effective' },
    ]);

    const outOfScopeAcceptance = {
      ...acceptance,
      action_id: id(17),
      scope: otherArtifactScope,
      authorization: acknowledging([firstRevision], otherArtifactScope),
    } as CorrectionAction;
    const pending = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        corrections: [published(2, proposal), published(3, outOfScopeAcceptance)],
      }),
      reading(3)
    );
    expect(pending.revisions[0]?.challenged_by).toEqual([]);
    expect(pending.correction_effects).toEqual([
      { action_id: proposal.action_id, standing: 'effective' },
    ]);
  });

  it('leaves an action unresolved when its followed action is unavailable', () => {
    const acceptance =
      correctionAndReversal.accepted['an accepted challenge to a requirement'].action;
    const answer = resolveKnowledge(
      holding(requirementIdentity, { corrections: [published(1, acceptance)] }),
      reading(1)
    );

    expect(answer.correction_effects).toEqual([
      { action_id: acceptance.action_id, standing: 'unresolved' },
    ]);
  });
});

describe('exceptions', () => {
  // A stored end time the schema would refuse today still has to be read, so
  // these are built from a valid exception rather than parsed.
  const ending = (ends: KnowledgeException['ends'], exception_id = id(30)): KnowledgeException => ({
    ...exceptionEndings.accepted.untilNextRelease,
    exception_id,
    ends,
  });

  const revoking = (revoked: string, revocation_id = id(31)): Revocation =>
    RevocationSchema.parse({
      revocation_id,
      revokes: { kind: 'exception', id: revoked },
      scope: projectScope,
      revoked_by: owner,
      source_id: id(2),
      instruction: instructionIn(projectScope),
      recorded_at: '2026-09-17T00:00:00.000Z',
    } satisfies Revocation);

  const endedYesterday = ExceptionSchema.parse(
    ending({ kind: 'until_time', until: '2026-09-16T00:00:00.000Z' })
  );

  it.each(Object.entries(exceptionEndings.standing))('%s', (_name, example) => {
    const exception = ending(example.exception.ends);
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        exceptions: [at(1, exception)],
        revocations: example.at.revoked ? [at(1, revoking(exception.exception_id))] : [],
      }),
      reading(1, {
        exceptions_judged_at: example.at.time ?? null,
        exception_conditions:
          example.at.condition_met === undefined
            ? {}
            : { [exception.exception_id]: example.at.condition_met },
      })
    );
    expect(answer.exceptions[0]?.standing).toBe(example.standing);
  });

  it('leaves an exception with an unknown end unresolved, and says so', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        exceptions: [at(1, exceptionEndings.accepted.cloudOnlyReportException)],
      }),
      reading(1, { exceptions_judged_at: '2026-09-17T00:00:00.000Z' })
    );
    expect(answer.exceptions[0]).toMatchObject({ standing: 'unresolved' });
    expect(answer.unresolved).toContainEqual({
      about: 'exception',
      record_ids: [exceptionEndings.accepted.cloudOnlyReportException.exception_id],
      reason: 'end_unknown',
    });
  });

  it('ends an exception a revocation names and keeps what was done under it', () => {
    const exception = exceptionEndings.accepted.cloudOnlyReportException;
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(1, adopting(id(10), firstRevision))],
        exceptions: [at(2, exception)],
        revocations: [at(3, revoking(exception.exception_id))],
      }),
      reading(3, { exceptions_judged_at: '2026-09-17T00:00:00.000Z' })
    );
    expect(answer.exceptions[0]).toMatchObject({
      standing: 'ended',
      revoked_by: [id(31)],
      expectation_stands: true,
    });
    expect(answer.governing_state.selection_ids).toEqual([id(10)]);
  });

  it('restores nothing that was withdrawn when an exception ends', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [published(3, withdrawing(id(12), [firstRevision]))],
        exceptions: [at(4, endedYesterday)],
      }),
      reading(4, { exceptions_judged_at: '2026-09-17T00:00:00.000Z' })
    );
    expect(answer.exceptions[0]).toMatchObject({
      standing: 'ended',
      end_behavior: 'expectation_applies_again',
      expectation_stands: false,
    });
    expect(answer.revisions[0]).toMatchObject({ standing: 'stopped' });
    expect(answer.governing_state.selection_ids).toEqual([]);
  });
});

describe('conflict answers', () => {
  const refusal = informedAuthorization.declinedCloudStartup;
  const conflicted = (answers: readonly (typeof refusal)[]) =>
    resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [
          published(2, adopting(id(10), firstRevision)),
          published(3, adopting(id(11), laterRevision)),
        ],
        conflict_answers: answers.map((record) => at(4, record)),
      }),
      reading(4, { applicability: { work_context: ['cloud-startup'] } })
    );

  it('carries a recorded refusal into the conflict and still asks about the rest', () => {
    expect(conflicted([refusal]).conflicts[0]?.disposition).toEqual({
      action: 'ask_once',
      declined: [firstRevision],
      unacknowledged: [laterRevision],
      answer_ids: [],
      assignment_ids: [],
    });
  });

  it('complies without asking again once every conflicting rule was refused', () => {
    const both = [refusal, { ...refusal, answer_id: id(60), rule: laterRevision }];
    expect(conflicted(both).conflicts[0]?.disposition).toEqual({
      action: 'comply',
      declined: [firstRevision, laterRevision],
      unacknowledged: [],
      answer_ids: [],
      assignment_ids: [],
    });
  });

  it('gives no disposition where a conflict answer cannot name the rule', () => {
    const claim = { kind: 'claim' as const, entity_id: id(70), revision_id: id(71) };
    const other = { ...claim, revision_id: id(72) };
    const answer = resolveKnowledge(
      holding(
        { kind: 'claim', entity_id: claim.entity_id },
        {
          revisions: [at(1, knowledgeRevision(claim)), at(1, knowledgeRevision(other))],
          selections: [
            published(2, adopting(id(10), claim)),
            published(3, adopting(id(11), other)),
          ],
        }
      ),
      reading(3)
    );
    expect(answer.conflicts).toEqual([
      { scope: projectScope, revisions: [claim, other], disposition: null },
    ]);
  });
});

describe('assignments in view', () => {
  const responsible = { identity: 'claude-code', basis: 'source_attributed' as const };
  const acting = { kind: 'actor' as const, actor: responsible };
  const besides = (rule: ExpectationRevisionRef) => ({
    rule,
    how: 'stands_beside' as const,
    exception_id: null,
    replaced_by: null,
  });
  const delegating = (change: Partial<Assignment> = {}): Assignment => ({
    assignment_id: id(80),
    objective: 'Keep the retry queue idempotent.',
    inherited: [],
    delegated: {
      adopts: [],
      departs_from: [besides(firstRevision), besides(laterRevision)],
      restates: [],
    },
    allowed_changes: ['Retry scheduling inside the upload queue.'],
    escalation_conditions: ['Anything about what is captured offline.'],
    responsible,
    assigned_by: owner,
    source_id: id(1),
    scope: projectScope,
    authorization: acknowledging([firstRevision, laterRevision]),
    valid_until: null,
    ...change,
  });

  const revokingAssignment = (assignment_id: string): Revocation => ({
    revocation_id: id(81),
    revokes: { kind: 'assignment', id: assignment_id },
    scope: projectScope,
    revoked_by: owner,
    source_id: id(1),
    instruction: instructionIn(projectScope),
    recorded_at: '2026-09-18T10:00:00.000Z',
  });

  const inConflict = (
    assignment: Assignment,
    held: Partial<KnowledgeRecords> = {},
    request: Partial<KnowledgeReadRequest> = {}
  ) =>
    resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [
          published(2, adopting(id(10), firstRevision)),
          published(3, adopting(id(11), laterRevision)),
        ],
        assignments: [at(4, { assignment, basis_stands: true })],
        ...held,
      }),
      reading(4, { acting, ...request })
    );

  it('rests a conflict on a valid assignment instead of asking about it again', () => {
    const answer = inConflict(delegating());
    expect(answer.conflicts[0]?.disposition).toEqual({
      action: 'rest_on_assignment',
      unacknowledged: [],
      declined: [],
      answer_ids: [],
      assignment_ids: [id(80)],
    });
    expect(answer.unresolved).not.toContainEqual(
      expect.objectContaining({ reason: 'conflict_unanswered' })
    );
  });

  it('asks again once a revocation reaching its scope ends the assignment', () => {
    const answer = inConflict(delegating(), {
      revocations: [at(4, revokingAssignment(id(80)))],
    });
    expect(answer.conflicts[0]?.disposition?.action).toBe('ask_once');
    expect(answer.assignments?.[0]).toMatchObject({ standing: 'revoked', revoked_by: [id(81)] });
  });

  it('complies with a recorded refusal whatever the assignment delegates', () => {
    const answer = inConflict(
      delegating(),
      { conflict_answers: [at(4, informedAuthorization.declinedCloudStartup)] },
      { applicability: { work_context: ['cloud-startup'] } }
    );
    expect(answer.conflicts[0]?.disposition).toMatchObject({
      action: 'comply',
      declined: [firstRevision],
    });
  });

  it('asks again once a rule the assignment rests on no longer stands', () => {
    const answer = inConflict(delegating(), {
      assignments: [at(4, { assignment: delegating(), basis_stands: false })],
    });
    expect(answer.conflicts[0]?.disposition?.action).toBe('ask_once');
    expect(answer.assignments?.[0]?.standing).toBe('basis_ended');
  });

  it('reports an assignment that ends at a time this read cannot judge as neither valid nor expired', () => {
    const ending = delegating({ valid_until: '2026-12-01T00:00:00.000Z' });
    expect(inConflict(ending).assignments?.[0]?.standing).toBe('not_judgeable');
    expect(
      inConflict(ending, {}, { exceptions_judged_at: '2026-12-02T00:00:00.000Z' }).assignments?.[0]
        ?.standing
    ).toBe('expired');
    expect(
      inConflict(ending, {}, { exceptions_judged_at: '2026-11-30T00:00:00.000Z' }).assignments?.[0]
        ?.standing
    ).toBe('valid');
  });

  it('carries what an assignment delegates about this identity and nothing it delegates about another', () => {
    const otherRule: ExpectationRevisionRef = {
      kind: 'decision',
      entity_id: id(90),
      revision_id: id(91),
    };
    const answer = inConflict(
      delegating({
        inherited: [firstRevision, otherRule],
        delegated: {
          adopts: [],
          departs_from: [besides(firstRevision), besides(otherRule)],
          restates: [],
        },
      })
    );
    expect(answer.assignments?.[0]).toMatchObject({
      assignment_id: id(80),
      objective: 'Keep the retry queue idempotent.',
      responsible,
      inherits: [firstRevision],
      escalation_conditions: ['Anything about what is captured offline.'],
      standing: 'valid',
    });
    expect(answer.assignments?.[0]?.delegates.departs_from).toEqual([besides(firstRevision)]);
  });

  it('leaves out an assignment that names another identity or acts in another scope', () => {
    const elsewhere = delegating({
      assignment_id: id(82),
      scope: otherArtifactScope,
      authorization: acknowledging([firstRevision, laterRevision], otherArtifactScope),
    });
    const answer = inConflict(delegating(), {
      assignments: [
        at(4, { assignment: delegating(), basis_stands: true }),
        at(4, { assignment: elsewhere, basis_stands: true }),
      ],
    });
    expect((answer.assignments ?? []).map((entry) => entry.assignment_id)).toEqual([id(80)]);
    expect(answer.omissions).toContainEqual({
      record: 'assignment',
      record_id: id(82),
      reason: 'another_scope',
    });
  });

  it('names an assignment published after the boundary rather than judging it', () => {
    const answer = inConflict(delegating(), {
      assignments: [at(9, { assignment: delegating(), basis_stands: true })],
    });
    expect(answer.assignments).toEqual([]);
    expect(answer.later_annotations).toContainEqual({
      record: 'assignment',
      record_id: id(80),
      write_sequence: 9,
      correction: null,
      recorded_at: null,
    });
  });
});

describe('applicability', () => {
  it.each(Object.entries(applicabilityLookup))('%s', (_name, example) => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision, { applicability: example.selector }))],
        selections: [published(1, adopting(id(10), firstRevision))],
      }),
      reading(1, { applicability: example.inputs })
    );
    expect(answer.revisions[0]?.applicability).toBe(example.applicability);
  });

  it('answers a lookup with no implementation selected and leaves what it needs unresolved', () => {
    const selector = applicabilityLookup['applies when every input is known and met'].selector;
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision, { applicability: selector }))],
        selections: [published(1, adopting(id(10), firstRevision))],
      }),
      reading(1)
    );
    expect(answer.basis.implementation).toEqual({ kind: 'none_selected' });
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands', applicability: 'unresolved' });
    expect(answer.unresolved).toContainEqual({
      about: 'revision',
      record_ids: [firstRevision.revision_id],
      reason: 'applicability_inputs_missing',
    });
  });
});

describe('revoked authority', () => {
  it('keeps an adoption standing and says the authority it rests on ended', () => {
    const revocation = RevocationSchema.parse({
      revocation_id: id(31),
      revokes: { kind: 'authorization', id: id(40) },
      scope: projectScope,
      revoked_by: owner,
      source_id: id(2),
      instruction: instructionIn(projectScope),
      recorded_at: '2026-10-01T10:00:00.000Z',
    } satisfies Revocation);
    const revoked = holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(firstRevision))],
      selections: [published(2, adopting(id(10), firstRevision), id(40))],
      revocations: [at(3, revocation)],
    });
    const answer = resolveKnowledge(revoked, reading(3));
    expect(answer.revisions[0]).toMatchObject({
      standing: 'stands',
      authority_revoked_by: [{ selection_id: id(10), revocation_ids: [id(31)] }],
    });
    expect(answer.governing_state.selection_ids).toEqual([id(10)]);

    const readopted = holding(requirementIdentity, {
      ...revoked,
      selections: [...revoked.selections, published(4, adopting(id(11), firstRevision), id(41))],
    });
    expect(resolveKnowledge(readopted, reading(4)).revisions[0]).toMatchObject({
      standing: 'stands',
      stood_by: [id(10), id(11)],
      authority_revoked_by: [{ selection_id: id(10), revocation_ids: [id(31)] }],
    });
  });

  it('carries the revocation of the authorization an adoption reuses', () => {
    const revocation = RevocationSchema.parse({
      revocation_id: id(31),
      revokes: { kind: 'authorization', id: id(40) },
      scope: projectScope,
      revoked_by: owner,
      source_id: id(2),
      instruction: instructionIn(projectScope),
      recorded_at: '2026-10-01T10:00:00.000Z',
    } satisfies Revocation);
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [
          published(
            2,
            adopting(id(10), firstRevision, {
              authorization: { kind: 'reused_authorization', authorization_id: id(40) },
            })
          ),
        ],
        revocations: [at(3, revocation)],
      }),
      reading(3)
    );
    expect(answer.revisions[0]?.authority_revoked_by).toEqual([
      { selection_id: id(10), revocation_ids: [id(31)] },
    ]);
  });
});

describe('imported inconsistent history', () => {
  const edge = (relationship_id: string, from: RecordRevisionRef, to: RecordRevisionRef) =>
    RelationshipSchema.parse({
      relationship_id,
      relation: 'supersedes',
      from,
      to,
      scope: projectScope,
      standing: 'established',
      attributed_to: { kind: 'actor', actor: owner },
      authorization: acknowledging([to as ExpectationRevisionRef]),
      source_ids: [id(3)],
      explanation: 'Imported history.',
    });

  it('reports a replacement cycle, terminates, and hides neither revision', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [
          published(2, adopting(id(10), firstRevision)),
          published(3, adopting(id(11), laterRevision)),
        ],
        relationships: [
          published(1, edge(id(20), laterRevision, firstRevision)),
          published(1, edge(id(21), firstRevision, laterRevision)),
        ],
      }),
      reading(3)
    );
    expect(answer.unresolved).toContainEqual({
      about: 'relationship',
      record_ids: [id(20), id(21)],
      reason: 'replacement_cycle',
    });
    expect(answer.revisions.map((entry) => entry.standing)).toEqual(['stands', 'stands']);
    expect(answer.revisions.every((entry) => entry.in_replacement_cycle)).toBe(true);
    expect(answer.conflicts).toHaveLength(1);
  });

  it('applies a replacement chain that does not close a loop', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(2, adopting(id(10), firstRevision))],
        relationships: [published(1, edge(id(20), laterRevision, firstRevision))],
      }),
      reading(2)
    );
    expect(answer.unresolved.some((point) => point.reason === 'replacement_cycle')).toBe(false);
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({ standing: 'stopped' });
  });

  it('reports a branch-scoped row as it is and lets it govern nothing', () => {
    const row = {
      record_id: id(50),
      record: 'selection' as const,
      branch: 'feature/retry',
      target: firstRevision,
      designation: 'adopted' as const,
    };
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        branch_scoped_rows: [at(1, row)],
      }),
      reading(1)
    );
    expect(answer.branch_scoped).toEqual([row]);
    expect(answer.omissions).toEqual([
      { record: 'branch_scoped_row', record_id: id(50), reason: 'branch_scope' },
    ]);
    expect(answer.governing_state).toEqual({ selection_ids: [], correction_action_ids: [] });
    expect(answer.revisions[0]).toMatchObject({ standing: 'unadopted' });
  });
});

describe('the answer itself', () => {
  const records = holding(requirementIdentity, {
    revisions: bothRevisions,
    selections: [
      published(2, adopting(id(10), firstRevision)),
      published(3, adopting(id(11), laterRevision)),
    ],
    corrections: [published(4, withdrawing(id(12), [laterRevision]))],
    exceptions: [at(5, exceptionEndings.accepted.untilNextRelease)],
  });

  it('is plain data that survives being frozen into a record', () => {
    const answer = resolveKnowledge(records, reading(5));
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
  });

  it('orders every list the same way whatever order the records arrive in', () => {
    const reversed = holding(requirementIdentity, {
      revisions: [...records.revisions].reverse(),
      selections: [...records.selections].reverse(),
      corrections: [...records.corrections].reverse(),
      exceptions: [...records.exceptions].reverse(),
    });
    expect(resolveKnowledge(reversed, reading(5))).toEqual(resolveKnowledge(records, reading(5)));
  });

  it('says that evidence and assessment standing are not attached', () => {
    const answer = resolveKnowledge(records, reading(5));
    expect(answer.evidence).toEqual({ kind: 'not_attached' });
    expect(answer.unresolved).toContainEqual({
      about: 'evidence',
      record_ids: [],
      reason: 'evidence_not_attached',
    });
  });

  it('accepts only records the contract would accept', () => {
    expect(SelectionSchema.safeParse(adopting(id(10), firstRevision)).success).toBe(true);
    expect(CorrectionActionSchema.safeParse(withdrawing(id(12), [firstRevision])).success).toBe(
      true
    );
  });
});

describe('a replacement relationship, read at the rule it suppresses', () => {
  const edgeId = id(20);
  const edge = replacementEdge(edgeId, laterRevision, firstRevision);
  const withdrawal = withdrawing(id(12), [relationshipRef(edgeId)]);
  const held = {
    revisions: bothRevisions,
    selections: [published(2, adopting(id(10), firstRevision))],
    relationships: [published(3, edge)],
  };

  it('stops the rule standing while the relationship stands', () => {
    const answer = resolveKnowledge(holding(requirementIdentity, held), reading(3));
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({ standing: 'stopped' });
    expect(answer.relationships[0]).toMatchObject({
      standing: 'established',
      applied: true,
      not_applied: null,
    });
  });

  it('brings the rule back when the relationship is withdrawn, at the rule identity', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, { ...held, corrections: [published(4, withdrawal)] }),
      reading(4)
    );
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({ standing: 'stands' });
    expect(answer.relationships[0]).toMatchObject({
      standing: 'withdrawn',
      applied: false,
      not_applied: 'withdrawn',
    });
    expect(answer.omissions).toEqual([]);
    expect(answer.governing_state).toEqual({
      selection_ids: [id(10)],
      correction_action_ids: [id(12)],
    });
  });

  it('answers the same about the relationship whichever identity is read', () => {
    const records = holding(requirementIdentity, {
      ...held,
      corrections: [published(4, withdrawal)],
    });
    const asRule = resolveKnowledge(records, reading(4));
    const asRelationship = resolveKnowledge(
      { ...records, target: { kind: 'relationship', entity_id: edgeId } },
      reading(4)
    );
    expect(asRelationship.relationships).toEqual(asRule.relationships);
    expect(asRelationship.governing_state.correction_action_ids).toEqual(
      asRule.governing_state.correction_action_ids
    );
  });

  it('stops the rule again when the withdrawal is reversed', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        ...held,
        corrections: [
          published(4, withdrawal),
          published(5, reversing(id(13), withdrawal, { kind: 'none' })),
        ],
      }),
      reading(5)
    );
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({ standing: 'stopped' });
    expect(answer.relationships[0]).toMatchObject({ standing: 'established', applied: true });
    expect(answer.omissions).toEqual([]);
  });

  it('lets a suggested replacement stop nothing', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        ...held,
        relationships: [
          published(
            3,
            replacementEdge(edgeId, laterRevision, firstRevision, {
              standing: 'suggested',
              attributed_to: detector,
              authorization: null,
            })
          ),
        ],
      }),
      reading(3)
    );
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({ standing: 'stands' });
    expect(answer.relationships[0]).toMatchObject({ applied: false, not_applied: 'suggested' });
  });

  it('says when an adoption stands against the replacement that keeps it stopped', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        ...held,
        selections: [...held.selections, published(4, adopting(id(11), firstRevision))],
      }),
      reading(4)
    );
    expect(standingOf(answer.revisions, firstRevision)[0]?.because).toEqual([
      { record: 'selection', record_id: id(10), effect: 'adopted' },
      { record: 'selection', record_id: id(11), effect: 'adopted' },
      { record: 'relationship', record_id: edgeId, effect: 'superseded_by_relationship' },
    ]);
    expect(answer.unresolved).toContainEqual({
      about: 'revision',
      record_ids: [firstRevision.revision_id],
      reason: 'adopted_while_replaced',
    });
  });
});

it('does not treat a relationship id shared with another identity kind as that identity', () => {
  const sharedId = requirementIdentity.entity_id;
  const unrelated: Relationship = {
    ...replacementEdge(sharedId, laterRevision, firstRevision),
    relation: 'depends_on',
    from: { ...laterRevision, entity_id: 'other-a' },
    to: { ...firstRevision, entity_id: 'other-b' },
  };

  const answer = resolveKnowledge(
    holding(requirementIdentity, { relationships: [published(3, unrelated)] }),
    reading(3)
  );

  expect(answer.relationships).toEqual([]);
  expect(answer.omissions).toContainEqual({
    record: 'relationship',
    record_id: sharedId,
    reason: 'another_identity',
  });
});

describe('what a detector may do', () => {
  it('reports a correction attributed to a detector instead of applying it', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [
          published(3, { ...withdrawing(id(12), [firstRevision]), attributed_to: detector }),
        ],
      }),
      reading(3)
    );
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands' });
    expect(answer.governing_state).toEqual({
      selection_ids: [id(10)],
      correction_action_ids: [],
    });
    expect(answer.unresolved).toContainEqual({
      about: 'correction',
      record_ids: [id(12)],
      reason: 'detector_cannot_act',
    });
  });

  it('reports an established replacement a detector is attributed with, and applies nothing', () => {
    // A row an upgrade or an import can hold: every released relationship was
    // read as established, a detector's among them.
    const byDetector = {
      ...replacementEdge(id(20), laterRevision, firstRevision),
      attributed_to: detector,
      authorization: null,
    } as Relationship;
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: bothRevisions,
        selections: [published(2, adopting(id(10), firstRevision))],
        relationships: [published(3, byDetector)],
      }),
      reading(3)
    );
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({ standing: 'stands' });
    expect(answer.relationships[0]).toMatchObject({
      standing: 'established',
      applied: false,
      not_applied: 'detector_attribution',
    });
  });
});

describe('an act in a narrower scope', () => {
  const artifactReplacement = replacing(id(12), [firstRevision], laterRevision, {
    scope: artifactScope,
    authorization: acknowledging([firstRevision], artifactScope),
  });
  const records = holding(requirementIdentity, {
    revisions: bothRevisions,
    selections: [published(2, adopting(id(10), firstRevision))],
    corrections: [published(3, artifactReplacement)],
  });

  it('departs from the project rule for the artifact, without a conflict to ask about', () => {
    const answer = resolveKnowledge(records, reading(3, { scope: artifactScope }));
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({
      standing: 'stands',
      scope: projectScope,
      departed_in_scope: [{ record_id: id(12), scope: artifactScope, effect: 'replaced' }],
    });
    expect(standingOf(answer.revisions, laterRevision)[0]).toMatchObject({
      standing: 'stands',
      scope: artifactScope,
    });
    expect(answer.conflicts).toEqual([]);
    expect(answer.governing_state.correction_action_ids).toEqual([id(12)]);
  });

  it('leaves the project read exactly as it was', () => {
    const answer = resolveKnowledge(records, reading(3));
    expect(standingOf(answer.revisions, firstRevision)[0]).toMatchObject({
      standing: 'stands',
      departed_in_scope: [],
    });
    expect(answer.omissions).toEqual([
      { record: 'correction', record_id: id(12), reason: 'another_scope' },
    ]);
    expect(answer.governing_state).toEqual({
      selection_ids: [id(10)],
      correction_action_ids: [],
    });
  });

  it('stops an artifact adoption when the project withdraws the rule, and names itself', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [
          published(
            2,
            adopting(id(11), firstRevision, {
              scope: artifactScope,
              authorization: instructionIn(artifactScope),
            })
          ),
        ],
        corrections: [published(3, withdrawing(id(12), [firstRevision]))],
      }),
      reading(3, { scope: artifactScope })
    );
    expect(answer.revisions[0]).toMatchObject({
      standing: 'stopped',
      scope: artifactScope,
      because: [
        { record: 'selection', record_id: id(11), effect: 'adopted' },
        { record: 'correction', record_id: id(12), effect: 'withdrawn' },
      ],
    });
  });

  it("keeps one artifact's acts out of another artifact's answer", () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [
          published(
            2,
            adopting(id(11), firstRevision, {
              scope: artifactScope,
              authorization: instructionIn(artifactScope),
            })
          ),
        ],
      }),
      reading(2, { scope: otherArtifactScope })
    );
    expect(answer.governing_state).toEqual({ selection_ids: [], correction_action_ids: [] });
    expect(answer.omissions).toEqual([
      { record: 'selection', record_id: id(11), reason: 'another_scope' },
    ]);
  });
});

describe('one conflict, asked once', () => {
  it('holds every adopted revision in one entry, whatever scopes they were adopted in', () => {
    const third = { ...firstRevision, revision_id: id(70) };
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [...bothRevisions, at(1, knowledgeRevision(third))],
        selections: [
          published(2, adopting(id(10), firstRevision)),
          published(3, adopting(id(11), laterRevision)),
          published(
            4,
            adopting(id(12), third, {
              scope: artifactScope,
              authorization: instructionIn(artifactScope),
            })
          ),
        ],
      }),
      reading(4, { scope: artifactScope })
    );
    expect(answer.conflicts).toHaveLength(1);
    expect(answer.conflicts[0]).toMatchObject({
      scope: null,
      revisions: [firstRevision, laterRevision, third],
    });
    const unanswered = answer.unresolved.filter((point) => point.reason === 'conflict_unanswered');
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0]?.record_ids).toEqual(
      [firstRevision.revision_id, laterRevision.revision_id, third.revision_id].sort()
    );
  });
});

describe('a correction the resolver cannot judge', () => {
  it('reports a kind it does not understand instead of passing over it', () => {
    // A kind no build of this contract defines, as a synced or imported row
    // could still carry one.
    const unknown = {
      ...withdrawing(id(12), [firstRevision]),
      kind: 'quarantine',
    } as unknown as CorrectionAction;
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [published(3, unknown)],
      }),
      reading(3)
    );
    expect(answer.unresolved).toContainEqual({
      about: 'correction',
      record_ids: [id(12)],
      reason: 'correction_kind_not_understood',
    });
    expect(answer.governing_state.correction_action_ids).toEqual([]);
  });

  it('reports a reversal whose followed action it was not given', () => {
    const orphan = reversing(id(13), withdrawing(id(999), [firstRevision]), {
      kind: 'revision',
      revision: firstRevision,
      designation: 'adopted',
    });
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [published(3, withdrawing(id(12), [firstRevision])), published(4, orphan)],
      }),
      reading(4)
    );
    expect(answer.unresolved).toContainEqual({
      about: 'correction',
      record_ids: [id(13)],
      reason: 'followed_action_not_supplied',
    });
    expect(answer.revisions[0]).toMatchObject({ standing: 'stopped' });
  });
});

describe('a reversal that names no resulting selection', () => {
  it('changes what stands and says so', () => {
    const withdrawal = withdrawing(id(12), [firstRevision]);
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [
          published(3, withdrawal),
          published(4, reversing(id(13), withdrawal, { kind: 'none' })),
        ],
      }),
      reading(4)
    );
    expect(answer.revisions[0]).toMatchObject({
      standing: 'stopped',
      because: [
        { record: 'selection', record_id: id(10), effect: 'adopted' },
        { record: 'correction', record_id: id(12), effect: 'withdrawn' },
        { record: 'correction', record_id: id(13), effect: 'corrected' },
      ],
    });
    expect(answer.governing_state.correction_action_ids).toEqual([id(12), id(13)]);
  });

  it('leaves a retracted proposal out of the governing state', () => {
    const challenge = CorrectionActionSchema.parse({
      action_id: id(14),
      kind: 'challenge',
      targets: [firstRevision],
      scope: projectScope,
      attributed_to: { kind: 'actor', actor: owner },
      source_id: id(2),
      authorization: null,
      expected_state: { kind: 'initial' },
      explanation: 'Offline capture may be unaffordable on the smallest devices.',
    });
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        corrections: [
          published(3, challenge),
          published(4, reversing(id(15), challenge, { kind: 'none' }, { authorization: null })),
        ],
      }),
      reading(4)
    );
    expect(answer.governing_state.correction_action_ids).toEqual([]);
    expect(answer.proposals[0]).toMatchObject({ action_id: id(14), retracted_by: id(15) });
  });
});

describe('a cycle that runs through another identity', () => {
  it('preserves a revision when replacement graph coverage is incomplete', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        replacement_graph_complete: false,
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        relationships: [published(1, replacementEdge(id(20), firstRevision, laterRevision))],
      }),
      reading(2)
    );
    expect(answer.unresolved).toContainEqual({
      about: 'relationship',
      record_ids: [id(20)],
      reason: 'replacement_graph_incomplete',
    });
    expect(answer.relationships[0]).toMatchObject({
      relationship_id: id(20),
      applied: false,
      not_applied: 'replacement_graph_incomplete',
    });
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands' });
  });

  it('keeps the other identity out of the answer and names it as an omission', () => {
    const foreign = { kind: 'requirement' as const, entity_id: id(200), revision_id: id(201) };
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        relationships: [
          published(1, replacementEdge(id(20), firstRevision, foreign)),
          published(1, replacementEdge(id(21), foreign, firstRevision)),
        ],
      }),
      reading(2)
    );
    expect(answer.revisions.map((entry) => entry.revision.entity_id)).toEqual([
      requirementIdentity.entity_id,
    ]);
    expect(answer.omissions).toContainEqual({
      record: 'revision',
      record_id: foreign.revision_id,
      reason: 'another_identity',
    });
    expect(answer.unresolved).toContainEqual({
      about: 'relationship',
      record_ids: [id(20), id(21)],
      reason: 'replacement_cycle',
    });
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands', in_replacement_cycle: true });
  });

  it('breaks and restores a project cycle only in the artifact where correction applies', () => {
    const foreign = { kind: 'requirement' as const, entity_id: id(200), revision_id: id(201) };
    const firstEdge = replacementEdge(id(20), firstRevision, foreign);
    const secondEdge = replacementEdge(id(21), foreign, firstRevision);
    const withdrawal = withdrawing(id(12), [relationshipRef(firstEdge.relationship_id)], {
      scope: artifactScope,
      authorization: acknowledging([firstRevision], artifactScope),
    });
    const reversal = reversing(id(13), withdrawal, { kind: 'none' }, { scope: artifactScope });
    const records = holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(firstRevision))],
      relationships: [published(1, firstEdge), published(1, secondEdge)],
      corrections: [published(2, withdrawal), published(3, reversal)],
    });
    const hasCycle = (boundary: number, scope: AuthorityScope) =>
      resolveKnowledge(records, reading(boundary, { scope })).unresolved.some(
        (point) => point.reason === 'replacement_cycle'
      );

    expect(hasCycle(1, artifactScope)).toBe(true);
    expect(hasCycle(2, artifactScope)).toBe(false);
    expect(hasCycle(2, otherArtifactScope)).toBe(true);
    expect(hasCycle(3, artifactScope)).toBe(true);
  });

  it('reports a row that replaces its own revision', () => {
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(2, adopting(id(10), firstRevision))],
        relationships: [
          published(1, {
            ...replacementEdge(id(20), firstRevision, laterRevision),
            to: firstRevision,
          } as Relationship),
        ],
      }),
      reading(2)
    );
    expect(answer.unresolved).toContainEqual({
      about: 'relationship',
      record_ids: [id(20)],
      reason: 'replacement_cycle',
    });
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands' });
  });

  it('keeps a branch-scoped row of another identity out of the answer', () => {
    const foreign = { kind: 'requirement' as const, entity_id: id(200), revision_id: id(201) };
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        branch_scoped_rows: [
          at(1, {
            record_id: id(50),
            record: 'selection' as const,
            branch: 'main',
            target: firstRevision,
            designation: 'adopted' as const,
          }),
          at(1, {
            record_id: id(51),
            record: 'selection' as const,
            branch: 'main',
            target: foreign,
            designation: 'adopted' as const,
          }),
        ],
      }),
      reading(1)
    );
    expect(answer.branch_scoped.map((row) => row.record_id)).toEqual([id(50)]);
    expect(answer.omissions).toContainEqual({
      record: 'branch_scoped_row',
      record_id: id(51),
      reason: 'another_identity',
    });
  });
});

describe('inconsistent history at scale', () => {
  const longChain = (links: number) => {
    const corrections = [published(2, withdrawing(id(1000), [firstRevision]))];
    let previous = corrections[0]?.record as CorrectionAction;
    for (let step = 1; step < links; step += 1) {
      const action = reversing(
        id(1000 + step),
        previous,
        step % 2 === 1
          ? { kind: 'revision', revision: firstRevision, designation: 'adopted' }
          : { kind: 'none' }
      );
      corrections.push(published(2 + step, action));
      previous = action;
    }
    return holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(firstRevision))],
      selections: [published(1, adopting(id(10), firstRevision))],
      corrections,
    });
  };

  it('answers a chain far longer than the bound without recursing away', () => {
    const records = longChain(5000);
    const started = Date.now();
    const answer = resolveKnowledge(records, reading(5002));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.unresolved.some((point) => point.reason === 'followed_chain_too_long')).toBe(
      true
    );
  });

  it('answers a large replacement graph in one traversal', () => {
    const relationships = [];
    for (let step = 0; step < 5000; step += 1)
      relationships.push(
        published(
          1,
          replacementEdge(
            id(3000 + step),
            { ...firstRevision, revision_id: id(9000 + step) },
            { ...firstRevision, revision_id: id(9001 + step) }
          )
        )
      );
    relationships.push(
      published(
        1,
        replacementEdge(
          id(8000),
          { ...firstRevision, revision_id: id(9000 + 5000) },
          { ...firstRevision, revision_id: id(9000) }
        )
      )
    );
    const started = Date.now();
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        relationships,
      }),
      reading(1)
    );
    expect(Date.now() - started).toBeLessThan(2000);
    const cycle = answer.unresolved.filter((point) => point.reason === 'replacement_cycle');
    expect(cycle).toHaveLength(1);
    expect(cycle[0]?.record_ids).toHaveLength(5001);
  });

  it('reports a chain that follows itself in a loop', () => {
    const first = reversing(id(2001), withdrawing(id(2003), [firstRevision]), { kind: 'none' });
    const second = reversing(id(2002), first, { kind: 'none' });
    const third = { ...reversing(id(2003), second, { kind: 'none' }) };
    const answer = resolveKnowledge(
      holding(requirementIdentity, {
        revisions: [at(1, knowledgeRevision(firstRevision))],
        selections: [published(1, adopting(id(10), firstRevision))],
        corrections: [published(2, first), published(3, second), published(4, third)],
      }),
      reading(4)
    );
    expect(
      answer.unresolved.filter((point) => point.reason === 'followed_action_cycle')
    ).not.toHaveLength(0);
    expect(answer.revisions[0]).toMatchObject({ standing: 'stands' });
  });
});

describe('an exception id that names something on the prototype', () => {
  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'leaves an exception called %s unresolved while no condition is supplied',
    (exception_id) => {
      const exception = {
        ...exceptionEndings.accepted.untilNextRelease,
        exception_id,
        ends: { kind: 'until_condition' as const, condition: 'the runner is rebuilt' },
      };
      const answer = resolveKnowledge(
        holding(requirementIdentity, { exceptions: [at(1, exception)] }),
        reading(1, { exception_conditions: {} })
      );
      expect(answer.exceptions[0]?.standing).toBe('unresolved');
    }
  );
});

describe('the governing state a writer observes', () => {
  it('is what the resolver answers, through its own entry point', () => {
    const records = holding(requirementIdentity, {
      revisions: bothRevisions,
      selections: [published(2, adopting(id(10), firstRevision))],
      corrections: [published(3, replacing(id(12), [firstRevision], laterRevision))],
    });
    expect(governingStateOf(records, reading(3))).toEqual({
      selection_ids: [],
      correction_action_ids: [id(12)],
    });
    expect(governingStateOf(records, reading(2))).toEqual({
      selection_ids: [id(10)],
      correction_action_ids: [],
    });
  });
});

describe('what the answer owns', () => {
  it('changes nothing when the request or the records change afterwards', () => {
    const inputs = { environment: ['ci'] };
    const row = {
      record_id: id(50),
      record: 'selection' as const,
      branch: 'main',
      target: { ...firstRevision },
      designation: 'adopted' as const,
    };
    const records = holding(requirementIdentity, {
      revisions: [at(1, knowledgeRevision(firstRevision))],
      branch_scoped_rows: [at(1, row)],
    });
    const answer = resolveKnowledge(records, reading(1, { applicability: inputs }));
    const frozen = JSON.parse(JSON.stringify(answer));
    inputs.environment.push('production');
    row.branch = 'rewritten-after-the-answer';
    row.target.revision_id = id(999);
    expect(answer).toEqual(frozen);
  });
});
