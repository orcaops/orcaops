// What an approval bound, the resolutions that answered it, and whether each one's revision still
// stands at the boundary the read is taken at.
import { afterEach, expect, it } from 'vitest';

import { publishProjectApprovalBinding } from './knowledge-approval-bindings.js';
import {
  readProjectApprovalAtBoundary,
  readProjectBindingAtBoundary,
} from './knowledge-read-bindings.js';
import { type KnowledgeBoundary, knowledgeReadRequest } from './knowledge-read-boundary.js';
import {
  createProjectRequirement,
  publishProjectRequirementRevision,
} from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { publishProjectSelectorResolution } from './knowledge-selector-resolutions.js';
import {
  acceptedSelection,
  AT,
  type AuthorityStore,
  authorityStore,
  BY_OWNER,
  establishReplacement,
  informedBy,
  instructedBy,
  observing,
  requirementRevision,
} from '../../../tests/knowledge-authority-store.js';
import { counters, discardKnowledgeStores, OWNER, read } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { ExpectationRevisionRef } from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const PASSAGE = 'Local capture works with no Cloud connection.';

const APPROVAL = {
  sourcePlanRef: 'cloud:example-plan',
  version: '2',
  planContentSha256: 'a'.repeat(64),
};

const approvalAt = (store: AuthorityStore, boundary: KnowledgeBoundary) =>
  read(store.handle, (view) =>
    readProjectApprovalAtBoundary(
      view,
      APPROVAL,
      store.authority.projectId,
      knowledgeReadRequest(view, {
        scope: store.project,
        mode: boundary === 'now' ? 'current' : 'historical',
        boundary,
      })
    )
  );

/**
 * An approval that bound one passage, a requirement that states it verbatim, the resolution that
 * answered the binding, and an adoption of the revision it resolved to.
 */
async function boundAndResolved() {
  const store = await authorityStore();
  const selector = {
    source_id: store.sourceId,
    location: 'section 3',
    passage_sha256: digest(Buffer.from(PASSAGE)),
  };
  const requirementId = uuidv7();
  const revision = requirementRevision(requirementId, store.sourceId, {
    statement: PASSAGE,
    passages: [selector],
  });
  await createProjectRequirement(store.handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: { kind: 'authored', source_id: store.sourceId },
    },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const resolved: ExpectationRevisionRef = {
    kind: 'requirement',
    entity_id: requirementId,
    revision_id: revision.revision_id,
  };
  const bindingId = uuidv7();
  const beforeBinding = counters(store.handle).writeSequence;
  await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: {
      binding_id: bindingId,
      approval: {
        source_plan_ref: APPROVAL.sourcePlanRef,
        version: APPROVAL.version,
        plan_content_sha256: APPROVAL.planContentSha256,
      },
      targets: [
        {
          target: { kind: 'source_selector', selector },
          scope: store.project,
          designation: 'adopted',
        },
        {
          target: { kind: 'revision', revision: store.target },
          scope: store.project,
          designation: 'adopted',
        },
      ],
      departures: [],
      authorization_evidence_source_id: store.instructionId,
    },
    approvedBy: OWNER,
    secretAllow: [],
  });
  await publishProjectSelectorResolution(store.handle, {
    operationId: uuidv7(),
    resolution: {
      binding_id: bindingId,
      selector,
      resolved,
      scope: store.project,
      designation: 'adopted',
    },
    secretAllow: [],
  });
  const adoption = acceptedSelection(
    resolved,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: adoption,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  return {
    store,
    bindingId,
    selector,
    requirementId,
    resolved,
    adoption,
    beforeBinding,
    bound: counters(store.handle).writeSequence,
  };
}

/** The resolved revision replaced by a successor, as a later act does it. */
async function replaceResolved(bound: Awaited<ReturnType<typeof boundAndResolved>>) {
  const { store, resolved, adoption } = bound;
  const successor = requirementRevision(bound.requirementId, store.sourceId, {
    previousRevisionId: resolved.revision_id,
    statement:
      'Local capture works with no Cloud connection, and says so when it cannot reach one.',
  });
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: successor,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const replacement: ExpectationRevisionRef = {
    kind: 'requirement',
    entity_id: bound.requirementId,
    revision_id: successor.revision_id,
  };
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      replacement,
      store.project,
      informedBy(store.instructionId, [resolved], store.project),
      { expectedState: observing([adoption.selection_id]) }
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  await establishReplacement(store.handle, {
    from: replacement,
    to: resolved,
    scope: store.project,
    sourceId: store.instructionId,
  });
  return replacement;
}

it('reads a resolution as bound then and not standing now once its revision was replaced', async () => {
  const bound = await boundAndResolved();
  await replaceResolved(bound);
  const then = approvalAt(bound.store, bound.bound).bindings[0];
  expect(then?.resolutions).toEqual([
    expect.objectContaining({
      standing: 'adopted',
      resolution: expect.objectContaining({
        bindingId: bound.bindingId,
        resolved: {
          kind: 'requirement',
          entityId: bound.requirementId,
          revisionId: bound.resolved.revision_id,
        },
      }),
    }),
  ]);
  const now = approvalAt(bound.store, 'now').bindings[0];
  expect(now?.resolutions.map((entry) => entry.standing)).toEqual(['not_standing']);
  expect(now?.resolutions[0]?.resolution.resolved.revisionId).toBe(bound.resolved.revision_id);
});

it('says nothing about the revision a bound source selector names, and what stands for a bound revision', async () => {
  const bound = await boundAndResolved();
  const binding = approvalAt(bound.store, 'now').bindings[0];
  const selectorTarget = binding?.targets.find(
    (entry) => entry.target.boundKind === 'source_selector'
  );
  expect(selectorTarget?.standing).toBeNull();
  expect(selectorTarget?.target.selector).toEqual({
    sourceId: bound.selector.source_id,
    location: bound.selector.location,
    passageSha256: bound.selector.passage_sha256,
  });
  const revisionTarget = binding?.targets.find((entry) => entry.target.boundKind === 'revision');
  expect(revisionTarget?.standing).toBe('not_standing');
  expect(revisionTarget?.target.revision).toEqual({
    kind: 'requirement',
    entityId: bound.store.requirementId,
    revisionId: bound.store.revisionId,
  });
});

it('leaves a binding published after the boundary out of the answer', async () => {
  const bound = await boundAndResolved();
  expect(approvalAt(bound.store, bound.beforeBinding).bindings).toEqual([]);
  expect(approvalAt(bound.store, 'now').bindings.map((entry) => entry.binding.bindingId)).toEqual([
    bound.bindingId,
  ]);
});

it('leaves a resolution published after the boundary out of its binding', async () => {
  const bound = await boundAndResolved();
  const atBinding = approvalAt(bound.store, bound.beforeBinding + 1).bindings[0];
  expect(atBinding?.binding.bindingId).toBe(bound.bindingId);
  expect(atBinding?.resolutions).toEqual([]);
  expect(approvalAt(bound.store, 'now').bindings[0]?.resolutions).toHaveLength(1);
});

it('returns one binding by its identity with every column the writer recorded', async () => {
  const bound = await boundAndResolved();
  const answer = read(bound.store.handle, (view) =>
    readProjectBindingAtBoundary(
      view,
      bound.bindingId,
      bound.store.authority.projectId,
      knowledgeReadRequest(view, { scope: bound.store.project, mode: 'current', boundary: 'now' })
    )
  );
  expect(answer?.binding).toMatchObject({
    bindingId: bound.bindingId,
    approval: {
      sourcePlanRef: APPROVAL.sourcePlanRef,
      version: APPROVAL.version,
      planContentSha256: APPROVAL.planContentSha256,
    },
    approvedBy: { identity: OWNER.identity, basis: OWNER.basis },
    authorizationEvidenceSourceId: bound.store.instructionId,
    departures: [],
  });
  expect(answer?.writeSequence).toBeGreaterThan(0);
  expect(answer?.coverage.boundary).toBe(counters(bound.store.handle).writeSequence);
});

it('returns nothing for a binding published after the boundary', async () => {
  const bound = await boundAndResolved();
  const answer = read(bound.store.handle, (view) =>
    readProjectBindingAtBoundary(
      view,
      bound.bindingId,
      bound.store.authority.projectId,
      knowledgeReadRequest(view, { scope: bound.store.project, mode: 'historical', boundary: 1 })
    )
  );
  expect(answer).toBeNull();
});
