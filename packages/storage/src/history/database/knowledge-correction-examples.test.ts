// The contract's executable correction examples, replayed through the real operations: what
// `checkCorrection` accepts a real store accepts, and what it refuses it refuses.
//
// Three adjustments, recorded here and in the writers' notes. The examples name a project of their
// own, so every scope is read against the project of the store replaying them. They name a
// governing state of their own — one selection id for every target — so each act observes the state
// the replaying store actually holds, and the expected-state rule keeps its own tests. And the
// store reads the chain an act follows from the act's own id, so the cases that hand
// `checkCorrection` a chain the act never named have no shape in a real store.
import { afterEach, expect, it } from 'vitest';

import { type ProjectDatabase } from './connection.js';
import { publishProjectApprovalBinding } from './knowledge-approval-bindings.js';
import { publishProjectAuthorization } from './knowledge-authorizations.js';
import { publishProjectContinuingClaimRevision } from './knowledge-claims.js';
import { appendProjectCorrection, correctionRefusalMessage } from './knowledge-corrections.js';
import { publishProjectContinuingDecisionRevision } from './knowledge-decisions.js';
import { publishProjectRelationship } from './knowledge-relationships.js';
import {
  createProjectRequirement,
  publishProjectRequirementRevision,
} from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { publishProjectKnowledgeSource } from './knowledge-sources.js';
import { resolveProjectKnowledge } from './knowledge-standing.js';
import {
  authorityInTheStore,
  canonicalCriterionReuse,
  correctionAndReversal,
  findingsAsClaims,
  requirementFollowedEndToEnd,
} from '../../../tests/knowledge-contract-examples.js';
import {
  AGENT,
  capturePlan,
  discardKnowledgeStores,
  knowledgeStore,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { isProposingCorrection } from '../../schema/knowledge-contract.js';
import type {
  ApprovalBinding,
  AuthorityScope,
  CorrectionAction,
  CorrectionRefusal,
  ExpectedState,
  FollowedCorrection,
  GoverningState,
  RecordRevisionRef,
  RelationshipTarget,
  Selection,
} from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-18T09:00:00.000Z';
const INSTRUCTIONS = ['informed_instruction', 'explicit_instruction'];

const { accepted, refusedByTheStore } = correctionAndReversal;
const { identity, firstRevision } = canonicalCriterionReuse;
const criterion = identity.origin.criterion;
const { duplicateUploadFinding } = findingsAsClaims;
const FINDING_PASSAGE = duplicateUploadFinding.passages[0]!;
const CAPTURE_SOURCE = firstRevision.source_ids[0] as string;
/** The artifact the examples withdraw a finding inside, so the finding has to originate there. */
const RETRY_ARTIFACT = (
  accepted['a withdrawal of a finding from its own artifact, with no authority'].action.scope as {
    artifact_id: string;
  }
).artifact_id;
/** The decision the examples name has no example revision of its own, so the store writes three. */
const DECISION_SOURCE = '01a0b111-0000-7000-8000-000000000001';

/** Every record the examples name, taken from the examples rather than named twice. */
const replacement = accepted['a replacement of a decision by someone who acknowledged it']
  .action as Extract<CorrectionAction, { kind: 'accepted_replacement' }>;
const STORAGE_DECISION = replacement.targets[0]!;
const STORAGE_DECISION_SUCCESSOR = replacement.replacement;
const SIBLING_DECISION = (
  accepted['a replacement beside another adopted revision that the instruction also acknowledges']
    .adopted_beside as RecordRevisionRef[]
)[0]!;
const CORRECTED_FINDING = (
  accepted['a corrected finding replacing the original in its own artifact'].action as Extract<
    CorrectionAction,
    { kind: 'accepted_replacement' }
  >
).replacement;
const REQUIREMENT_SUCCESSOR = requirementFollowedEndToEnd.standsAtTheEnd;
const EXAMPLE_PROJECT = (
  accepted['a challenge to a finding'].action.scope as { project_id: string }
).project_id;

const local = <T>(value: T, projectId: string): T =>
  JSON.parse(JSON.stringify(value).replaceAll(EXAMPLE_PROJECT, projectId)) as T;

const without = <T extends object, K extends keyof T>(record: T, ...keys: K[]): Omit<T, K> => {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
};

const CITING_KEYS: readonly string[] = [
  'source_id',
  'instruction_source_id',
  'authorization_evidence_source_id',
];

/** Every source an example cites, so the store holds the ones it names. */
function citedSources(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) citedSources(entry, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    if (CITING_KEYS.includes(key) && typeof entry === 'string') found.add(entry);
    else citedSources(entry, found);
  }
  return found;
}

interface ExampleCase {
  action: CorrectionAction;
  followed: FollowedCorrection | null;
  relationship_targets?: readonly RelationshipTarget[];
  adopted_beside?: readonly { kind: string; entity_id: string; revision_id: string }[];
}

interface ReplayStore {
  handle: ProjectDatabase;
  projectId: string;
  project: AuthorityScope;
}

const instruction = (sourceId: string, scope: AuthorityScope) =>
  ({ kind: 'explicit_instruction', instruction_source_id: sourceId, scope }) as const;

const decisionRevision = (
  revisionId: string,
  previousRevisionId: string | null,
  location: string
) => ({
  decision_id: STORAGE_DECISION.entity_id,
  revision_id: revisionId,
  previous_revision_id: previousRevisionId,
  chosen_approach: `The approach recorded by revision ${revisionId}.`,
  rationale: 'The duplicate comes from the retry itself, not from its timing.',
  alternatives: [],
  assumptions: [],
  reconsideration_conditions: [],
  subject: null,
  applicability: { all_of: [] },
  source_ids: [DECISION_SOURCE],
  passages: [
    {
      source_id: DECISION_SOURCE,
      location,
      passage_sha256: digest(Buffer.from(location, 'utf8')),
    },
  ],
  source_standing: 'explicit_instruction',
  derivation: null,
  recorded_at: AT,
});

const claimRevision = (
  revisionId: string,
  previousRevisionId: string | null,
  statement: string
) => ({
  claim_id: duplicateUploadFinding.claim_id,
  revision_id: revisionId,
  previous_revision_id: previousRevisionId,
  statement,
  subject: null,
  applicability: { all_of: [] },
  source_ids: [FINDING_PASSAGE.source_id],
  passages: [FINDING_PASSAGE],
  source_standing: 'agent_proposal',
  observation_ids: [],
  verification: null,
  recorded_at: AT,
});

/**
 * A store holding every record the correction examples name: both artifacts, the sources the case
 * cites, the requirement and its successor, the decision with three revisions, and the finding with
 * the corrected account of it.
 */
async function exampleStore(replaying: unknown): Promise<ReplayStore> {
  const { handle, authority } = await knowledgeStore();
  const projectId = authority.projectId;
  const project: AuthorityScope = { kind: 'project', project_id: projectId };
  await capturePlan(handle, {
    artifactId: criterion.artifact_id,
    planEventId: criterion.plan_event_id,
    steps: [
      { stepId: uuidv7(), criteria: [{ criterionId: criterion.criterion_id, text: 'Offline' }] },
    ],
  });
  const retryPlanEvent = uuidv7();
  await capturePlan(handle, {
    artifactId: RETRY_ARTIFACT,
    planEventId: retryPlanEvent,
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Retry once' }] }],
    task: 'Make upload retries idempotent',
  });
  const captureField = async (
    sourceId: string,
    artifactId: string,
    eventId: string,
    path: string
  ) =>
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: {
        source_id: sourceId,
        occurrence: {
          kind: 'capture_field',
          artifact_id: artifactId,
          event_id: eventId,
          field_path: path,
          position: 0,
        },
        source_author: OWNER,
        interpreted_by: null,
        access_restriction: null,
      },
      recordedBy: AGENT,
      secretAllow: [],
    });
  await captureField(
    CAPTURE_SOURCE,
    criterion.artifact_id,
    criterion.plan_event_id,
    'plan_steps[0].acceptance_criteria[0].text'
  );
  // Where the finding originates is a fact about the store, and the case says which one it needs:
  // the retry artifact, which is what lets that artifact withdraw it, or somewhere else entirely.
  const elsewhere =
    (replaying as { findings_originate_in_scope?: boolean }).findings_originate_in_scope === false;
  const findingArtifact = elsewhere ? uuidv7() : RETRY_ARTIFACT;
  const findingEvent = elsewhere ? uuidv7() : retryPlanEvent;
  if (elsewhere)
    await capturePlan(handle, {
      artifactId: findingArtifact,
      planEventId: findingEvent,
      steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Report once' }] }],
      task: 'Report what the upload smoke found',
    });
  await captureField(
    FINDING_PASSAGE.source_id,
    findingArtifact,
    findingEvent,
    FINDING_PASSAGE.location
  );
  for (const sourceId of citedSources([replaying, authorityInTheStore]).add(DECISION_SOURCE)) {
    if (sourceId === CAPTURE_SOURCE || sourceId === FINDING_PASSAGE.source_id) continue;
    const bytes = Buffer.from(`The instruction retained as ${sourceId}.`);
    await publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: {
        source_id: sourceId,
        occurrence: {
          kind: 'user_instruction',
          retention: { kind: 'bytes', content_sha256: digest(bytes) },
          location: 'session transcript, turn 4',
          source_time: AT,
        },
        source_author: OWNER,
        interpreted_by: null,
        access_restriction: null,
      },
      recordedBy: AGENT,
      retainedBytes: bytes,
      secretAllow: [],
    });
  }
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: without(firstRevision, 'attributed_to'),
    attributedTo: firstRevision.attributed_to,
    secretAllow: [],
  });
  await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: {
      ...without(firstRevision, 'attributed_to'),
      revision_id: REQUIREMENT_SUCCESSOR.revision_id,
      previous_revision_id: firstRevision.revision_id,
      statement: 'Local capture and local search work with no Cloud connection.',
    },
    attributedTo: firstRevision.attributed_to,
    secretAllow: [],
  });
  for (const revision of [
    decisionRevision(STORAGE_DECISION.revision_id, null, 'message 1'),
    decisionRevision(
      STORAGE_DECISION_SUCCESSOR.revision_id,
      STORAGE_DECISION.revision_id,
      'message 2'
    ),
    decisionRevision(SIBLING_DECISION.revision_id, STORAGE_DECISION.revision_id, 'message 3'),
  ])
    await publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision,
      attributedTo: { kind: 'actor', actor: OWNER },
      occurrence: {
        source_id: DECISION_SOURCE,
        location: revision.passages[0]!.location,
      },
      secretAllow: [],
    });
  for (const revision of [
    claimRevision(duplicateUploadFinding.revision_id, null, duplicateUploadFinding.statement),
    claimRevision(
      CORRECTED_FINDING.revision_id,
      duplicateUploadFinding.revision_id,
      'The defect was observed on the previous build, not this one.'
    ),
  ])
    await publishProjectContinuingClaimRevision(handle, {
      operationId: uuidv7(),
      revision,
      attributedTo: { kind: 'actor', actor: AGENT },
      occurrence: { source_id: FINDING_PASSAGE.source_id, location: FINDING_PASSAGE.location },
      secretAllow: [],
    });
  return { handle, projectId, project };
}

const governing = (
  store: ReplayStore,
  refs: readonly RecordRevisionRef[],
  scope: AuthorityScope
): Extract<ExpectedState, { kind: 'observed' }> => {
  const identities = new Map(refs.map((ref) => [`${ref.kind}:${ref.entity_id}`, ref]));
  const states: GoverningState[] = [...identities.values()].map(
    (ref) =>
      read(store.handle, (view) =>
        resolveProjectKnowledge(
          view,
          { kind: ref.kind, entity_id: ref.entity_id },
          store.projectId,
          scope,
          {}
        )
      ).governing_state
  );
  return {
    kind: 'observed',
    selection_ids: [...new Set(states.flatMap((state) => state.selection_ids))],
    correction_action_ids: [...new Set(states.flatMap((state) => state.correction_action_ids))],
  };
};

/**
 * The work an act reusing an earlier authorization is done for: the one that authorization's own
 * context covers, so the reuse is judged on its footprint and not turned away for other work.
 */
const workFor = (action: CorrectionAction): Record<string, string[]> | undefined => {
  if (action.authorization?.kind !== 'reused_authorization') return undefined;
  const { exceptionAuthorization } = authorityInTheStore;
  if (exceptionAuthorization.authorization_id !== action.authorization.authorization_id)
    return undefined;
  const work: Record<string, string[]> = {};
  for (const condition of exceptionAuthorization.context?.all_of ?? [])
    if (condition.operator === 'any_of') work[condition.dimension] = [...condition.values];
  return work;
};

const appendExample = (store: ReplayStore, action: CorrectionAction) =>
  appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      ...without(action, 'attributed_to'),
      expected_state: governing(store, action.targets, action.scope),
    },
    attributedTo: action.attributed_to,
    ...(INSTRUCTIONS.includes(action.authorization?.kind ?? '') ? { recordedAt: AT } : {}),
    work: workFor(action),
    secretAllow: [],
  });

/** The actions behind the one being replayed, oldest first, as the store has to hold them. */
const chainOf = (replaying: ExampleCase): CorrectionAction[] => {
  const chain: CorrectionAction[] = [];
  for (let link = replaying.followed; link !== null; link = link.followed)
    chain.unshift(link.action);
  return chain;
};

/** The binding or the earlier authorization an act cites, published as the examples hold it. */
async function authorityInPlace(store: ReplayStore, action: CorrectionAction) {
  const cited = action.authorization;
  if (cited?.kind === 'approval_binding') {
    // The authority table holds only the members it judges; the examples behind it are whole.
    const binding = authorityInTheStore.context.bindings.find(
      (candidate) => candidate.binding_id === cited.binding_id
    ) as ApprovalBinding | undefined;
    if (binding !== undefined)
      await publishProjectApprovalBinding(store.handle, {
        operationId: uuidv7(),
        binding: without(local(binding, store.projectId), 'approved_by'),
        approvedBy: binding.approved_by,
        secretAllow: [],
      });
  }
  if (cited?.kind !== 'reused_authorization') return;
  const { exceptionAuthorization } = authorityInTheStore;
  if (exceptionAuthorization.authorization_id !== cited.authorization_id) return;
  // An authorization stops being valid once a rule it departs from no longer stands, so the store
  // adopts each of those rules first; otherwise every act reusing it would be refused for being
  // invalid and the rule the example is about — leave to except is never leave to withdraw — would
  // never be reached.
  for (const departure of exceptionAuthorization.departs_from)
    await adopt(store, local(departure.rule, store.projectId));
  await publishProjectAuthorization(store.handle, {
    operationId: uuidv7(),
    authorization: without(local(exceptionAuthorization, store.projectId), 'granted_by'),
    grantedBy: exceptionAuthorization.granted_by,
    secretAllow: [],
  });
}

/** An accepted adoption of one revision, project wide, on an instruction of the store's own. */
const adopt = (store: ReplayStore, target: RecordRevisionRef) =>
  publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: {
      selection_id: uuidv7(),
      kind: 'accepted',
      target,
      scope: store.project,
      designation: 'adopted',
      authorization: instruction(DECISION_SOURCE, store.project),
      expected_state: governing(store, [target], store.project),
    },
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });

/** What the case says the store already knows, published through the writers that record it. */
async function inPlace(store: ReplayStore, replaying: ExampleCase) {
  await authorityInPlace(store, replaying.action);
  for (const known of replaying.relationship_targets ?? []) {
    const replaces = known.standing === 'established' && known.relation === 'supersedes';
    await publishProjectRelationship(store.handle, {
      operationId: uuidv7(),
      relationship: {
        relationship_id: known.relationship_id,
        relation: known.relation,
        from: known.from,
        to: known.to,
        scope: store.project,
        standing: known.standing,
        authorization: replaces
          ? {
              kind: 'informed_instruction',
              instruction_source_id: replaying.action.source_id,
              acknowledged: [known.to],
              scope: store.project,
            }
          : null,
        source_ids: [replaying.action.source_id],
        explanation: 'The example says the store holds this relationship.',
      },
      attributedTo: known.attributed_to,
      ...(replaces ? { recordedAt: AT } : {}),
      secretAllow: [],
    });
  }
  for (const beside of replaying.adopted_beside ?? [])
    await publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: {
        selection_id: uuidv7(),
        kind: 'accepted',
        target: beside,
        scope: store.project,
        designation: 'adopted',
        authorization: instruction(replaying.action.source_id, store.project),
        expected_state: governing(store, [beside as RecordRevisionRef], store.project),
      },
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    });
  for (const action of chainOf(replaying)) await appendExample(store, action);
}

async function replay(name: string, replaying: ExampleCase) {
  const store = await exampleStore(replaying);
  const localized = local(replaying, store.projectId);
  await inPlace(store, localized);
  return { store, localized, name };
}

/** How each revision the act names stands now, by revision id; a relationship has no standing here. */
const standings = (store: ReplayStore, action: CorrectionAction) =>
  new Map(
    action.targets
      .filter((target) => target.kind !== 'relationship')
      .map((target) => [
        target.revision_id,
        read(store.handle, (view) =>
          resolveProjectKnowledge(
            view,
            { kind: target.kind, entity_id: target.entity_id },
            store.projectId,
            action.scope,
            {}
          )
        ).revisions.find((entry) => entry.revision.revision_id === target.revision_id)?.standing ??
          'unadopted',
      ])
  );

const footprintOf = (entry: {
  footprint: { adopts?: number; departs?: string[]; restates?: number };
}) => entry.footprint;

for (const [name, entry] of Object.entries(accepted))
  it(`accepts ${name}`, async () => {
    const { store, localized } = await replay(name, entry as unknown as ExampleCase);
    const { action } = localized;
    const footprint = footprintOf(entry);
    // The example declares the footprint the store judges it on: an act with an empty one changes
    // nothing that stands and records no authorization, whatever it cites.
    const acts =
      (footprint.adopts ?? 0) + (footprint.departs ?? []).length + (footprint.restates ?? 0) > 0;
    const before = standings(store, action);
    const appended = await appendExample(store, action);

    expect(appended.value.changeClass).toBe(entry.changeClass);
    expect(appended.value.changedWhatStands).toBe(acts);
    expect(appended.value.authorizationId === null).toBe(
      !(acts && INSTRUCTIONS.includes(action.authorization?.kind ?? ''))
    );
    // Nothing else in this store adopts these revisions, so a proposing act leaves each one exactly
    // as it was, and an act that takes effect leaves none of them standing unless it restores one.
    const restored =
      action.kind === 'reversal' && action.resulting_selection.kind === 'revision'
        ? action.resulting_selection.revision.revision_id
        : null;
    for (const [revisionId, was] of standings(store, action)) {
      if (isProposingCorrection(action.kind)) expect(was, revisionId).toBe(before.get(revisionId));
      else if (revisionId === restored) expect(was, revisionId).toBe('stands');
      else expect(was, revisionId).not.toBe('stands');
    }
  });

/** The store answers a missing followed action and an unknown relationship as missing history. */
const MISSING: readonly string[] = [
  'a reversal given without the action it follows',
  'a withdrawal of a relationship the store knows nothing about',
];

/** Two cases hand the contract a chain the act never named, which no store can be put into. */
const UNREPLAYABLE: readonly string[] = [
  'a reversal given a different action than the one it names',
  'a second reversal of an action already reversed',
];

// The authority table's entries whose footprint only a correction produces, which
// `knowledge-contract-examples.ts` says this writer replays.
const refused = {
  ...refusedByTheStore,
  ...authorityInTheStore.correctionsRefusedOnAuthority,
};

for (const [name, entry] of Object.entries(refused))
  if (!UNREPLAYABLE.includes(name))
    it(`refuses ${name}`, async () => {
      const { store, localized } = await replay(name, entry as unknown as ExampleCase);
      // The words the store refuses with are the ones its table holds for the code the example
      // declares, so a case that is refused for some other reason fails here.
      await expect(appendExample(store, localized.action)).rejects.toMatchObject({
        code: MISSING.includes(name) ? 'HISTORY_MISSING' : 'INVALID_INPUT',
        message: correctionRefusalMessage((entry as { code: CorrectionRefusal }).code),
      });
      // Only the chain the case says the store already held is there; the refused act wrote nothing.
      expect(rowCount(store.handle, 'correction_actions')).toBe(chainOf(localized).length);
    });

it('follows one requirement from its approval to the successor that stands at the end', async () => {
  const store = await exampleStore(requirementFollowedEndToEnd);
  const { approval, laterApproval, steps } = local(requirementFollowedEndToEnd, store.projectId);
  for (const binding of [approval, laterApproval])
    await publishProjectApprovalBinding(store.handle, {
      operationId: uuidv7(),
      binding: without(binding, 'approved_by'),
      approvedBy: binding.approved_by,
      secretAllow: [],
    });
  const [adopting, challenging, replacing] = steps as unknown as [
    { record: Selection; governs: { selection_ids: string[] } },
    { record: CorrectionAction; governs: Record<string, never> },
    { record: CorrectionAction; governs: { correction_action_ids: string[] } },
  ];
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: without(adopting.record, 'selected_by'),
    selectedBy: adopting.record.selected_by,
    acceptedAt: AT,
    secretAllow: [],
  });
  const target = adopting.record.target;
  const stateNow = () => governing(store, [target], store.project);
  expect(stateNow().selection_ids).toEqual(adopting.governs.selection_ids);

  // A challenge proposes and governs nothing, so the state the replacement observes is unmoved.
  await appendExample(store, challenging.record);
  expect(stateNow()).toMatchObject({
    selection_ids: adopting.governs.selection_ids,
    correction_action_ids: [],
  });

  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: { ...without(replacing.record, 'attributed_to'), expected_state: stateNow() },
    attributedTo: replacing.record.attributed_to,
    secretAllow: [],
  });
  expect(stateNow().correction_action_ids).toEqual(replacing.governs.correction_action_ids);
  const resolved = read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: target.entity_id },
      store.projectId,
      store.project,
      {}
    )
  );
  expect(
    resolved.revisions
      .filter((entry) => entry.standing === 'stands')
      .map((entry) => entry.revision.revision_id)
  ).toEqual([local(requirementFollowedEndToEnd.standsAtTheEnd, store.projectId).revision_id]);
});
