// The contract's executable examples for the records that carry authority, replayed through the
// real operations: what the schemas and rule functions accept is what a real store accepts, and
// what they refuse it refuses.
//
// The examples name one project of their own, so every scope is read against the project of the
// store replaying them. Their synthetic passage hashes are the one thing a real revision cannot
// produce: a resolution accepted on a passage hash no statement hashes to is exercised by the
// selector resolution's own test instead.
import { afterEach, expect, it } from 'vitest';

import { publishProjectApprovalBinding } from './knowledge-approval-bindings.js';
import { publishProjectAuthorization } from './knowledge-authorizations.js';
import { publishProjectConflictAnswer } from './knowledge-conflict-answers.js';
import { publishProjectException } from './knowledge-exceptions.js';
import {
  createProjectRequirement,
  publishProjectRequirementRevision,
} from './knowledge-requirements.js';
import { publishProjectRevocation } from './knowledge-revocations.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { publishProjectSelectorResolution } from './knowledge-selector-resolutions.js';
import { publishProjectKnowledgeSource } from './knowledge-sources.js';
import * as examples from '../../../tests/knowledge-contract-examples.js';
import {
  canonicalCriterionReuse,
  exactApprovalBinding,
  exceptionEndings,
  informedAuthorization,
} from '../../../tests/knowledge-contract-examples.js';
import {
  AGENT,
  capturePlan,
  discardKnowledgeStores,
  knowledgeStore,
  OWNER,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const { identity, firstRevision, source } = canonicalCriterionReuse;
const criterion = identity.origin.criterion;
const { acceptedSelection, finishedTaskChoice, declinedCloudStartup, revokedException } =
  informedAuthorization;
const { boundApproval } = exactApprovalBinding;
const EXAMPLE_PROJECT = (acceptedSelection.scope as { project_id: string }).project_id;
const PASSAGE = exactApprovalBinding.selectorResolvedLocally.resolution.selector;
const RESOLVED = exactApprovalBinding.selectorResolvedLocally.resolution.resolved;

const without = <T extends object, K extends keyof T>(record: T, ...keys: K[]): Omit<T, K> => {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
};

/** Every scope in an example is read against the project of the store that replays it. */
const local = <T>(value: T, projectId: string): T =>
  JSON.parse(JSON.stringify(value).replaceAll(EXAMPLE_PROJECT, projectId)) as T;

const AT = '2026-09-17T09:00:00.000Z';

/** The adoption an example was written against, which its expected state names. */
const observing = (selectionIds: string[]) => ({
  kind: 'observed' as const,
  selection_ids: selectionIds,
  correction_action_ids: [],
});

const observedSelection = (expected: unknown) =>
  (expected as { selection_ids: string[] }).selection_ids[0] as string;

async function retainSource(handle: Parameters<typeof rowCount>[0], sourceId: string) {
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

/**
 * A store holding exactly the plan, sources and requirement the examples name. `standing` publishes
 * the adoption the examples that observe a governing state were written against.
 */
async function exampleStore(standing?: string) {
  const { handle, authority } = await knowledgeStore();
  await capturePlan(handle, {
    artifactId: criterion.artifact_id,
    planEventId: criterion.plan_event_id,
    steps: [
      {
        stepId: uuidv7(),
        criteria: [
          { criterionId: criterion.criterion_id, text: 'Local capture works with no Cloud' },
        ],
      },
    ],
  });
  await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: without(source, 'recorded_by'),
    recordedBy: source.recorded_by,
    secretAllow: [],
  });
  for (const sourceId of [
    boundApproval.authorization_evidence_source_id,
    (acceptedSelection.authorization as { instruction_source_id: string }).instruction_source_id,
    declinedCloudStartup.source_id,
    PASSAGE.source_id,
  ])
    await retainSource(handle, sourceId);
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity,
    revision: without(firstRevision, 'attributed_to'),
    attributedTo: firstRevision.attributed_to,
    secretAllow: [],
  });
  const projectId = authority.projectId;
  if (standing !== undefined)
    await publishProjectSelection(handle, {
      operationId: uuidv7(),
      selection: local(
        { ...without(acceptedSelection, 'selected_by'), selection_id: standing },
        projectId
      ),
      selectedBy: acceptedSelection.selected_by,
      acceptedAt: AT,
      secretAllow: [],
    });
  return { handle, projectId };
}

const publishSelection = (
  handle: Parameters<typeof rowCount>[0],
  projectId: string,
  selection: unknown,
  selectedBy = acceptedSelection.selected_by
) =>
  publishProjectSelection(handle, {
    operationId: uuidv7(),
    selection: local(without(selection as { selected_by?: unknown }, 'selected_by'), projectId),
    selectedBy,
    acceptedAt: selection === finishedTaskChoice ? undefined : AT,
    secretAllow: [],
  });

it('accepts the example acceptance and refuses the acceptances the contract refuses', async () => {
  const { handle, projectId } = await exampleStore();
  const published = await publishSelection(handle, projectId, acceptedSelection);
  expect(published.value).toMatchObject({
    selectionId: acceptedSelection.selection_id,
    recordedIn: 'adoptions',
  });
  for (const [name, refused] of Object.entries({
    acceptanceWithNoAuthorization: informedAuthorization.refused.acceptanceWithNoAuthorization,
    adoptionBroaderThanItsInstruction:
      informedAuthorization.refused.adoptionBroaderThanItsInstruction,
    finishedTaskPresentedAsAdoption: informedAuthorization.refused.finishedTaskPresentedAsAdoption,
    instructionThatAcknowledgesNothing: {
      ...acceptedSelection,
      selection_id: uuidv7(),
      authorization: informedAuthorization.refused.informedInstructionThatAcknowledgesNothing,
    },
  }))
    await expect(
      publishSelection(handle, projectId, { ...refused, selection_id: uuidv7() }),
      name
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'adoptions')).toBe(1);
});

it('records the finished task choice as a choice, beside the adoption it observed', async () => {
  const standing = observedSelection(informedAuthorization.acceptedException.expected_state);
  const { handle, projectId } = await exampleStore(standing);
  const published = await publishSelection(handle, projectId, finishedTaskChoice, AGENT);
  expect(published.value.recordedIn).toBe('recorded_choices');
  expect(rowCount(handle, 'adoptions')).toBe(1);
});

it('binds exactly what the approval bound, and inherits nothing when the binding changes', async () => {
  const { handle, projectId } = await exampleStore();
  const publishBinding = (binding: unknown) =>
    publishProjectApprovalBinding(handle, {
      operationId: uuidv7(),
      binding: local(without(binding as { approved_by?: unknown }, 'approved_by'), projectId),
      approvedBy: boundApproval.approved_by,
      secretAllow: [],
    });
  const bound = await publishBinding(boundApproval);
  expect(bound.value).toMatchObject({ targets: 2, departures: 0, inheritsApproval: false });
  expect(
    (await publishBinding(exactApprovalBinding.samePlanTextWithTheSameBinding)).value
  ).toMatchObject({ inheritsApproval: true });
  for (const [name, changed] of Object.entries(exactApprovalBinding.changedBindings))
    expect((await publishBinding(changed)).value.inheritsApproval, name).toBe(false);
  expect((await publishBinding(exactApprovalBinding.planApprovedWithNoTargets)).value.targets).toBe(
    0
  );
  await expect(
    publishBinding(exactApprovalBinding.refused.oneTargetBoundAsBothAdoptedAndBackground)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishBinding({
      ...boundApproval,
      binding_id: uuidv7(),
      targets: [
        {
          ...boundApproval.targets[0],
          scope: exactApprovalBinding.refused.branchAsAnAuthorityScope,
        },
      ],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('refuses a resolution that broadens its binding or states the passage differently', async () => {
  const { handle, projectId } = await exampleStore();
  await publishProjectApprovalBinding(handle, {
    operationId: uuidv7(),
    binding: local(without(boundApproval, 'approved_by'), projectId),
    approvedBy: boundApproval.approved_by,
    secretAllow: [],
  });
  // The revision the example resolves to, citing the approved passage but stating its own words.
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: RESOLVED.entity_id,
      origin: { kind: 'authored', source_id: PASSAGE.source_id },
    },
    revision: {
      ...without(firstRevision, 'attributed_to'),
      requirement_id: RESOLVED.entity_id,
      revision_id: RESOLVED.revision_id,
      source_ids: [PASSAGE.source_id],
      passages: [PASSAGE],
    },
    attributedTo: firstRevision.attributed_to,
    secretAllow: [],
  });
  const refused = exactApprovalBinding.refusedResolutions;
  for (const [name, entry] of Object.entries({
    'a broadened scope': refused['a broadened scope'],
    'background upgraded to adopted': refused['background upgraded to adopted'],
    'a revision that paraphrases the approved passage':
      refused['a revision that paraphrases the approved passage'],
  }))
    await expect(
      publishProjectSelectorResolution(handle, {
        operationId: uuidv7(),
        resolution: local(entry.resolution, projectId),
        secretAllow: [],
      }),
      name
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'selector_resolutions')).toBe(0);
});

it('retains the refused conflict answer and refuses one that names an authorization', async () => {
  const { handle, projectId } = await exampleStore();
  const published = await publishProjectConflictAnswer(handle, {
    operationId: uuidv7(),
    answer: local(without(declinedCloudStartup, 'answered_by'), projectId),
    answeredBy: declinedCloudStartup.answered_by,
    secretAllow: [],
  });
  expect(published.value.outcome).toBe('declined');
  await expect(
    publishProjectConflictAnswer(handle, {
      operationId: uuidv7(),
      answer: local(
        without(
          {
            ...informedAuthorization.refused.declinedAnswerNamingAnAuthorization,
            answer_id: uuidv7(),
          },
          'answered_by'
        ),
        projectId
      ),
      answeredBy: declinedCloudStartup.answered_by,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'conflict_answers')).toBe(1);
});

it('accepts each exception the contract accepts and refuses each one it refuses', async () => {
  const standing = observedSelection(
    exceptionEndings.accepted.cloudOnlyReportException.expected_state
  );
  const { handle, projectId } = await exampleStore(standing);
  const publishException = (exception: unknown) =>
    publishProjectException(handle, {
      operationId: uuidv7(),
      exception: local(without(exception as { granted_by?: unknown }, 'granted_by'), projectId),
      grantedBy: exceptionEndings.accepted.cloudOnlyReportException.granted_by,
      work: { work_context: ['cloud-only-report'] },
      secretAllow: [],
    });
  for (const [name, accepted] of Object.entries(exceptionEndings.accepted))
    expect((await publishException(accepted)).value.exceptionId, name).toBe(accepted.exception_id);
  for (const [name, refused] of Object.entries(exceptionEndings.refused))
    await expect(
      publishException({ ...refused.exception, exception_id: uuidv7() }),
      name
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_exceptions')).toBe(2);
});

it('ends the exception the example revokes and refuses a revocation instructed elsewhere', async () => {
  const standing = observedSelection(
    exceptionEndings.accepted.cloudOnlyReportException.expected_state
  );
  const { handle, projectId } = await exampleStore(standing);
  await publishProjectException(handle, {
    operationId: uuidv7(),
    exception: local(
      without(exceptionEndings.accepted.cloudOnlyReportException, 'granted_by'),
      projectId
    ),
    secretAllow: [],
    grantedBy: exceptionEndings.accepted.cloudOnlyReportException.granted_by,
    work: { work_context: ['cloud-only-report'] },
  });
  const published = await publishProjectRevocation(handle, {
    operationId: uuidv7(),
    revocation: local(without(revokedException, 'revoked_by'), projectId),
    revokedBy: revokedException.revoked_by,
    secretAllow: [],
  });
  expect(published.value.revokes).toEqual(revokedException.revokes);
  await expect(
    publishProjectRevocation(handle, {
      operationId: uuidv7(),
      revocation: local(
        without(
          {
            ...informedAuthorization.refused.revocationOnAnInstructionFromAnotherScope,
            revocation_id: uuidv7(),
          },
          'revoked_by'
        ),
        projectId
      ),
      revokedBy: revokedException.revoked_by,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_revocations')).toBe(1);
});

const { authorityInTheStore } = examples;
const { adoptionUnderTheBinding, exceptionAuthorization } = authorityInTheStore;
const cloudOnlyException = exceptionEndings.accepted.cloudOnlyReportException;
const REPORT_WORK = { work_context: ['cloud-only-report'] };

/** The bindings the contract's authorization table is judged against, published as they stand. */
async function bindingsInPlace(handle: Parameters<typeof rowCount>[0], projectId: string) {
  for (const binding of authorityInTheStore.context.bindings)
    await publishProjectApprovalBinding(handle, {
      operationId: uuidv7(),
      binding: local(without(binding as { approved_by?: unknown }, 'approved_by'), projectId),
      approvedBy: boundApproval.approved_by,
      secretAllow: [],
    });
}

const publishException = (
  handle: Parameters<typeof rowCount>[0],
  projectId: string,
  exception: unknown,
  work: unknown = REPORT_WORK
) =>
  publishProjectException(handle, {
    operationId: uuidv7(),
    exception: local(without(exception as { granted_by?: unknown }, 'granted_by'), projectId),
    grantedBy: cloudOnlyException.granted_by,
    work,
    secretAllow: [],
  });

it('adopts what an approval bound and refuses every adoption it did not bind', async () => {
  const { handle, projectId } = await exampleStore();
  await bindingsInPlace(handle, projectId);
  const successor = (
    exactApprovalBinding.approvalOfTheSuccessor.targets[0] as {
      target: { revision: { revision_id: string } };
    }
  ).target.revision;
  // The revision the successor approval bound, so the binding is what refuses an adoption of it.
  await publishProjectRequirementRevision(handle, {
    operationId: uuidv7(),
    revision: {
      ...without(firstRevision, 'attributed_to'),
      revision_id: successor.revision_id,
      previous_revision_id: adoptionUnderTheBinding.target.revision_id,
      statement: 'Local capture and local search work with no Cloud connection.',
    },
    attributedTo: firstRevision.attributed_to,
    secretAllow: [],
  });
  const published = await publishSelection(handle, projectId, adoptionUnderTheBinding);
  expect(published.value.selectionId).toBe(adoptionUnderTheBinding.selection_id);

  const observed = observing([adoptionUnderTheBinding.selection_id]);
  const refused = {
    'a binding for another scope': [
      { scope: { kind: 'artifact', artifact_id: uuidv7() } },
      'INVALID_INPUT',
    ],
    'a binding for another designation': [{ designation: 'background' }, 'INVALID_INPUT'],
    'a binding for another revision': [{ target: successor }, 'INVALID_INPUT'],
    'a binding that does not exist': [
      { authorization: { kind: 'approval_binding', binding_id: uuidv7() } },
      'HISTORY_MISSING',
    ],
  } as const;
  for (const [name, [change, code]] of Object.entries(refused))
    await expect(
      publishSelection(handle, projectId, {
        ...adoptionUnderTheBinding,
        ...change,
        selection_id: uuidv7(),
        expected_state: observed,
      }),
      name
    ).rejects.toMatchObject({ code });
  expect(rowCount(handle, 'adoptions')).toBe(1);
});

it('excepts a rule the approver was shown by name and refuses another exception under it', async () => {
  const { handle, projectId } = await exampleStore();
  await bindingsInPlace(handle, projectId);
  await publishSelection(handle, projectId, adoptionUnderTheBinding);
  const underTheApproval = {
    ...cloudOnlyException,
    authorization:
      authorityInTheStore.covered['an exception the approver was shown by name'].authorization,
    expected_state: observing([adoptionUnderTheBinding.selection_id]),
  };
  expect((await publishException(handle, projectId, underTheApproval)).value.exceptionId).toBe(
    cloudOnlyException.exception_id
  );
  await expect(
    publishException(handle, projectId, { ...underTheApproval, exception_id: uuidv7() })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_exceptions')).toBe(1);
});

it('reuses the authorization recorded for the same exception, and nothing else', async () => {
  const { handle, projectId } = await exampleStore();
  await bindingsInPlace(handle, projectId);
  await publishSelection(handle, projectId, adoptionUnderTheBinding);
  await publishProjectAuthorization(handle, {
    operationId: uuidv7(),
    authorization: local(without(exceptionAuthorization, 'granted_by'), projectId),
    grantedBy: exceptionAuthorization.granted_by,
    secretAllow: [],
  });
  const reused = {
    kind: 'reused_authorization',
    authorization_id: exceptionAuthorization.authorization_id,
  };
  const observed = observing([adoptionUnderTheBinding.selection_id]);
  const sameException = { ...cloudOnlyException, authorization: reused, expected_state: observed };
  expect((await publishException(handle, projectId, sameException)).value.exceptionId).toBe(
    cloudOnlyException.exception_id
  );

  const elsewhere = { kind: 'artifact', artifact_id: uuidv7() };
  await expect(
    publishException(handle, projectId, {
      ...sameException,
      exception_id: uuidv7(),
      authorization: { kind: 'reused_authorization', authorization_id: uuidv7() },
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  for (const [name, change] of Object.entries({
    'an earlier narrow exception reused for different work': {},
    'an earlier authorization for another scope': { scope: elsewhere },
  }))
    await expect(
      publishException(
        handle,
        projectId,
        { ...sameException, ...change, exception_id: uuidv7() },
        name.includes('different work') ? { work_context: ['nightly-sync'] } : REPORT_WORK
      ),
      name
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  // The same authorization cited to adopt, which its recorded footprint never covered.
  await expect(
    publishSelection(handle, projectId, {
      ...adoptionUnderTheBinding,
      selection_id: uuidv7(),
      authorization: reused,
      expected_state: observed,
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_exceptions')).toBe(1);
});

it('stops reusing an authorization a revocation ended', async () => {
  const { handle, projectId } = await exampleStore();
  await bindingsInPlace(handle, projectId);
  await publishSelection(handle, projectId, adoptionUnderTheBinding);
  await publishProjectAuthorization(handle, {
    operationId: uuidv7(),
    authorization: local(without(exceptionAuthorization, 'granted_by'), projectId),
    grantedBy: exceptionAuthorization.granted_by,
    secretAllow: [],
  });
  await publishProjectRevocation(handle, {
    operationId: uuidv7(),
    revocation: local(
      {
        ...without(revokedException, 'revoked_by'),
        revokes: { kind: 'authorization', id: exceptionAuthorization.authorization_id },
      },
      projectId
    ),
    revokedBy: revokedException.revoked_by,
    secretAllow: [],
  });
  await expect(
    publishException(handle, projectId, {
      ...cloudOnlyException,
      authorization: {
        kind: 'reused_authorization',
        authorization_id: exceptionAuthorization.authorization_id,
      },
      expected_state: observing([adoptionUnderTheBinding.selection_id]),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'knowledge_exceptions')).toBe(0);
});
