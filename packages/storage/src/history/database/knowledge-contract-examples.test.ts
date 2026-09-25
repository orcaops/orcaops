// The contract's executable examples, replayed through the real operations: what the schemas and
// rule functions accept is what a real store accepts, and what they refuse it refuses.
import { afterEach, expect, it } from 'vitest';

import { editProjectPromotedCriterion } from './knowledge-criterion-edits.js';
import {
  createProjectRequirement,
  publishProjectRequirementRevision,
  readProjectRequirement,
} from './knowledge-requirements.js';
import {
  publishProjectPassageRestatement,
  readProjectPassageRestatements,
} from './knowledge-restatements.js';
import { publishProjectKnowledgeSource, readProjectKnowledgeSource } from './knowledge-sources.js';
import { listProjectTaskUses, recordProjectTaskUses } from './knowledge-task-uses.js';
import {
  canonicalCriterionReuse,
  distinctDerivedObligation,
  informedAuthorization,
  passageRestatement,
  siblingRevisions,
} from '../../../tests/knowledge-contract-examples.js';
import {
  capturePlan,
  capturePlanWithTaskUses,
  counters,
  discardKnowledgeStores,
  knowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { Actor, Attribution } from '../../schema/knowledge-contract.js';

afterEach(discardKnowledgeStores);

const { identity, firstRevision, source, useByLaterTask, candidateFromProcessing, refused } =
  canonicalCriterionReuse;
const criterion = identity.origin.criterion;
const derivedCriterion = distinctDerivedObligation.identity.origin.derived_from.criterion;
const { connectionFoundAfterTheTask } = canonicalCriterionReuse;
const editOfThePromotedCriterion = informedAuthorization.editOfThePromotedCriterion;

const attribution = (revision: { attributed_to: Attribution }) => revision.attributed_to;
/** A fixture the contract refuses, handed to a typed argument so the writer refuses it too. */
const asActor = (value: unknown) => value as Actor;
const without = <T extends object, K extends keyof T>(record: T, ...keys: K[]): Omit<T, K> => {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
};

/**
 * A store holding exactly the artifacts, plans and criteria the examples name. The retry task's
 * plan is left uncaptured when its own settlement is the one that will record its uses, because
 * a use is an original selection only when the operation that wrote the plan event wrote it.
 */
async function exampleStore(deferRetryTask = false) {
  const { handle } = await knowledgeStore();
  const firstTask = {
    artifactId: criterion.artifact_id,
    planEventId: criterion.plan_event_id,
    steps: [
      {
        stepId: uuidv7(),
        criteria: [
          { criterionId: criterion.criterion_id, text: 'Local capture works with no Cloud' },
          { criterionId: derivedCriterion.criterion_id, text: 'A regression test covers it' },
        ],
      },
    ],
  };
  const retryTask = {
    artifactId: useByLaterTask.artifact_id,
    planEventId: useByLaterTask.plan_event_id,
    steps: [
      {
        stepId: useByLaterTask.local!.step_id,
        criteria: [{ criterionId: uuidv7(), text: 'Retry never blocks a capture' }],
      },
    ],
  };
  const laterTask = {
    artifactId: connectionFoundAfterTheTask.artifact_id,
    planEventId: connectionFoundAfterTheTask.plan_event_id,
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Sync retries' }] }],
  };
  await capturePlan(handle, firstTask);
  if (!deferRetryTask) await capturePlan(handle, retryTask);
  await capturePlan(handle, laterTask);
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: without(source, 'recorded_by'),
    recordedBy: source.recorded_by,
    secretAllow: [],
  });
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: distinctDerivedObligation.identity.origin.source_id,
      occurrence: {
        ...source.occurrence,
        field_path: 'plan_steps[0].acceptance_criteria[1].text',
      },
      source_author: source.source_author,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: source.recorded_by,
    secretAllow: [],
  });
  return { handle, retryTask };
}

const created = (handle: Parameters<typeof rowCount>[0]) =>
  createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: without(firstRevision, 'attributed_to'),
    attributedTo: attribution(firstRevision),
    secretAllow: [],
  });

it('gives the promoted criterion one identity, reached by a later task through an exact use', async () => {
  const { handle, retryTask } = await exampleStore(true);
  const requirement = await created(handle);
  expect(requirement.value.requirementId).toBe(criterion.criterion_id);

  await capturePlanWithTaskUses(handle, retryTask, [without(useByLaterTask, 'selection')]);
  const [pinned] = read(handle, (view) => listProjectTaskUses(view, useByLaterTask.plan_event_id));
  expect(JSON.parse(Buffer.from(pinned!.recordHex, 'hex').toString())).toEqual(useByLaterTask);

  const later = await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [without(connectionFoundAfterTheTask, 'selection')],
    discovery: {
      discovered_at: connectionFoundAfterTheTask.selection.discovered_at!,
      discovered_by: connectionFoundAfterTheTask.selection.discovered_by!,
    },
    secretAllow: [],
  });
  expect(later.value.uses[0]!.selectionKind).toBe('connected_later');
  const [found] = read(handle, (view) =>
    listProjectTaskUses(view, connectionFoundAfterTheTask.plan_event_id)
  );
  expect(JSON.parse(Buffer.from(found!.recordHex, 'hex').toString())).toEqual(
    connectionFoundAfterTheTask
  );
});

it('records a later source that repeats the requirement word for word and adds no revision', async () => {
  const { handle } = await exampleStore();
  await created(handle);
  const { restatingSource, statement, instructionRepeatingTheRequirement } = passageRestatement;
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: without(restatingSource, 'recorded_by'),
    recordedBy: restatingSource.recorded_by,
    retainedBytes: Buffer.from(statement),
    secretAllow: [],
  });
  expect(
    read(handle, (view) => readProjectKnowledgeSource(view, restatingSource.source_id))!
      .interpretedBy
  ).toEqual({ kind: 'detector', name: 'knowledge-processor', basis: null });

  const before = counters(handle);
  await publishProjectPassageRestatement(handle, {
    operationId: uuidv7(),
    restatement: without(instructionRepeatingTheRequirement, 'attributed_to'),
    attributedTo: instructionRepeatingTheRequirement.attributed_to,
    secretAllow: [],
  });
  expect(counters(handle)).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const [recorded] = read(handle, (view) =>
    readProjectPassageRestatements(view, instructionRepeatingTheRequirement.restates)
  ).restatements;
  expect(recorded!.passage).toEqual(instructionRepeatingTheRequirement.passage);
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);

  // A paraphrase of the same passage is a proposed revision, never a restatement.
  await expect(
    publishProjectPassageRestatement(handle, {
      operationId: uuidv7(),
      restatement: {
        ...without(instructionRepeatingTheRequirement, 'attributed_to'),
        restatement_id: uuidv7(),
        passage: { ...instructionRepeatingTheRequirement.passage, passage_sha256: 'e'.repeat(64) },
      },
      attributedTo: instructionRepeatingTheRequirement.attributed_to,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'passage_restatements')).toBe(1);
});

it('refuses a later connection that says nothing of its discovery', async () => {
  const { handle } = await exampleStore();
  await created(handle);
  await expect(
    recordProjectTaskUses(handle, {
      operationId: uuidv7(),
      uses: [without(connectionFoundAfterTheTask, 'selection')],
      discovery: null,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    recordProjectTaskUses(handle, {
      operationId: uuidv7(),
      uses: [refused.laterConnectionPresentedWithoutDiscovery],
      discovery: null,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'task_uses')).toBe(0);
});

it('keeps what a detector derives a candidate and refuses one presented as an instruction', async () => {
  const { handle } = await exampleStore();
  const before = counters(handle);
  const candidate = await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: candidateFromProcessing.requirement_id,
      origin: { kind: 'authored', source_id: source.source_id },
    },
    revision: without(candidateFromProcessing, 'attributed_to'),
    attributedTo: attribution(candidateFromProcessing),
    secretAllow: [],
  });
  expect(candidate.counters.intentChangeCounter).toBe(before.intentChangeCounter);
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: {
        requirement_id: refused.derivedRevisionPresentedAsAnInstruction.requirement_id,
        origin: { kind: 'authored', source_id: source.source_id },
      },
      revision: without(refused.derivedRevisionPresentedAsAnInstruction, 'attributed_to'),
      attributedTo: attribution(refused.derivedRevisionPresentedAsAnInstruction),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('refuses a competing copy of the criterion and a derived obligation under its source identity', async () => {
  const { handle } = await exampleStore();
  await created(handle);
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: refused.competingCopyUnderNewIdentity,
      revision: {
        ...without(firstRevision, 'attributed_to'),
        requirement_id: refused.competingCopyUnderNewIdentity.requirement_id,
        revision_id: uuidv7(),
      },
      attributedTo: attribution(firstRevision),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const sharing = distinctDerivedObligation.refused.derivedObligationSharingItsSourceIdentity;
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: sharing,
      revision: {
        ...without(firstRevision, 'attributed_to'),
        requirement_id: sharing.requirement_id,
        revision_id: uuidv7(),
      },
      attributedTo: attribution(firstRevision),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'requirements')).toBe(1);
});

it('mints its own identity for a derived obligation and records the derivation', async () => {
  const { handle } = await exampleStore();
  const derived = await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: distinctDerivedObligation.identity,
    revision: {
      ...without(firstRevision, 'attributed_to'),
      requirement_id: distinctDerivedObligation.identity.requirement_id,
      revision_id: uuidv7(),
      source_ids: [distinctDerivedObligation.identity.origin.source_id],
    },
    attributedTo: attribution(firstRevision),
    secretAllow: [],
  });
  expect(derived.value.published).toBe(true);
  expect(
    read(handle, (view) =>
      readProjectRequirement(view, distinctDerivedObligation.identity.requirement_id)
    )!.originKind
  ).toBe('derived');
});

it('refuses a source that is only a mutable URL, a blank actor and an id with whitespace', async () => {
  const { handle } = await exampleStore();
  await expect(
    publishProjectKnowledgeSource(handle, {
      operationId: uuidv7(),
      source: without(refused.sourceThatIsOnlyAMutableUrl, 'recorded_by'),
      recordedBy: refused.sourceThatIsOnlyAMutableUrl.recorded_by,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  for (const actor of [refused.namedActorWithUnknownBasis, refused.blankActorIdentity])
    await expect(
      publishProjectKnowledgeSource(handle, {
        operationId: uuidv7(),
        source: {
          ...without(source, 'recorded_by'),
          source_id: uuidv7(),
          occurrence: { ...source.occurrence, position: 7 },
        },
        recordedBy: asActor(actor),
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const whitespace = refused.recordIdContainingWhitespace;
  await expect(
    createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: {
        requirement_id: whitespace.criterion_id,
        origin: { kind: 'promoted_criterion', criterion: whitespace },
      },
      revision: {
        ...without(firstRevision, 'attributed_to'),
        requirement_id: whitespace.criterion_id,
        revision_id: uuidv7(),
      },
      attributedTo: attribution(firstRevision),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_sources')).toBe(2);
});

it('lets a second successor continue a revision that already has one, and refuses the rest', async () => {
  const { handle } = await exampleStore();
  await created(handle);
  const [, tighter] = siblingRevisions.lineage;
  for (const sibling of [tighter!, siblingRevisions.secondSuccessorOfTheSameRevision])
    await publishProjectRequirementRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...without(firstRevision, 'attributed_to'),
        revision_id: sibling.revision_id,
        previous_revision_id: sibling.previous_revision_id,
      },
      attributedTo: attribution(firstRevision),
      secretAllow: [],
    });
  const retained = read(handle, (view) =>
    readProjectRequirement(view, identity.requirement_id)
  )!.revisions.map((row) => row.revisionId);
  expect(retained.slice(1)).toEqual(siblingRevisions.tipsAfterBoth);

  const codes = {
    PREDECESSOR_NOT_IN_LINEAGE: 'INVALID_INPUT',
    LINEAGE_ALREADY_ROOTED: 'INVALID_INPUT',
    REVISION_ID_REUSED: 'IDEMPOTENCY_CONFLICT',
  } as const;
  for (const [name, entry] of Object.entries(siblingRevisions.refused))
    await expect(
      publishProjectRequirementRevision(handle, {
        operationId: uuidv7(),
        revision: {
          ...without(firstRevision, 'attributed_to'),
          revision_id: entry.next.revision_id,
          previous_revision_id: entry.next.previous_revision_id,
        },
        attributedTo: attribution(firstRevision),
        secretAllow: [],
      }),
      name
    ).rejects.toMatchObject({ code: codes[entry.code] });
  expect(rowCount(handle, 'requirement_revisions')).toBe(3);
});

it('writes a shared revision for one criterion edit, nothing shared for the other, and refuses a third', async () => {
  const { handle } = await exampleStore();
  await created(handle);
  const proposed = uuidv7();
  const edited = await editProjectPromotedCriterion(handle, {
    operationId: uuidv7(),
    edit: editOfThePromotedCriterion.sharedRevision,
    attributedTo: attribution(firstRevision),
    secretAllow: [],
    sharedRevision: {
      revision_id: proposed,
      subject: null,
      applicability: firstRevision.applicability,
      duration: firstRevision.duration,
      source_ids: firstRevision.source_ids,
      passages: firstRevision.passages,
      source_standing: 'agent_proposal',
      recorded_at: firstRevision.recorded_at,
    },
  });
  expect(edited.value.revisionId).toBe(proposed);

  const local = await editProjectPromotedCriterion(handle, {
    operationId: uuidv7(),
    edit: editOfThePromotedCriterion.taskLocalChange,
    attributedTo: attribution(firstRevision),
    secretAllow: [],
  });
  expect(local.value).toMatchObject({ revisionId: null, recordSha256: null });
  expect(rowCount(handle, 'requirement_revisions')).toBe(2);

  await expect(
    editProjectPromotedCriterion(handle, {
      operationId: uuidv7(),
      edit: informedAuthorization.refused.promotedCriterionEditWithNoAction,
      attributedTo: attribution(firstRevision),
      secretAllow: [],
      sharedRevision: { revision_id: uuidv7() },
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(2);
});
