// The link the contract asks for: an act published under an embedded instruction records an
// authorization carrying exactly its footprint and names it, so a revocation of that authorization
// reaches what was published under it without ever having been cited.
import { afterEach, expect, it } from 'vitest';

import { publishProjectApprovalBinding } from './knowledge-approval-bindings.js';
import { readProjectAuthorization } from './knowledge-authorizations.js';
import { publishProjectRelationship, readProjectRelationship } from './knowledge-relationships.js';
import { publishProjectRevocation } from './knowledge-revocations.js';
import { publishProjectSelection, readProjectSelection } from './knowledge-selections.js';
import { resolveProjectKnowledge } from './knowledge-standing.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  informedBy,
  instructedBy,
  observing,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  BY_OWNER,
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { AuthorityScope } from '../../schema/knowledge-contract.js';

afterEach(discardKnowledgeStores);

type Store = Awaited<ReturnType<typeof authorityStore>>;

const CLOUD_ONLY = { work_context: ['cloud-only-report'] };

const revoke = (store: Store, authorizationId: string, scope: AuthorityScope = store.project) =>
  publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: {
      revocation_id: uuidv7(),
      revokes: { kind: 'authorization', id: authorizationId },
      scope,
      source_id: store.instructionId,
      instruction: instructedBy(store.instructionId, scope),
      recorded_at: AT,
    },
    revokedBy: OWNER,
    secretAllow: [],
  });

const resolved = (store: Store) =>
  read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      store.project,
      CLOUD_ONLY
    )
  );

it('records the authorization an adoption was published under, with its footprint and work', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    work: CLOUD_ONLY,
    secretAllow: [],
  });
  const row = read(store.handle, (view) => readProjectSelection(view, selection.selection_id))!;
  expect(row.authorizationId).not.toBeNull();
  const recorded = read(store.handle, (view) =>
    readProjectAuthorization(view, row.authorizationId as string)
  )!;
  expect(JSON.parse(Buffer.from(recorded.recordHex, 'hex').toString())).toEqual({
    authorization_id: row.authorizationId,
    instruction: instructedBy(store.instructionId, store.project),
    adopts: [{ revision: store.target, designation: 'adopted' }],
    departs_from: [],
    restates: [],
    context: {
      all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-only-report'] }],
    },
    granted_by: OWNER,
    recorded_at: AT,
  });
});

it('reaches an adoption with a revocation of the authorization recorded for it', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    work: CLOUD_ONLY,
    secretAllow: [],
  });
  const authorizationId = read(store.handle, (view) =>
    readProjectSelection(view, selection.selection_id)
  )!.authorizationId as string;
  expect(resolved(store).revisions[0]?.authority_revoked_by).toEqual([]);

  const revocation = await revoke(store, authorizationId);
  const standing = resolved(store).revisions[0]!;
  // Revoking ends the authority from now on and preserves what was done under it.
  expect(standing.standing).toBe('stands');
  expect(standing.authority_revoked_by).toEqual([
    { selection_id: selection.selection_id, revocation_ids: [revocation.value.revocationId] },
  ]);
});

it('reaches an established replacement with a revocation of the authorization recorded for it', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const relationshipId = uuidv7();
  await publishProjectRelationship(store.handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: relationshipId,
      relation: 'supersedes',
      from: successor,
      to: store.target,
      scope: store.project,
      standing: 'established',
      authorization: informedBy(store.instructionId, [store.target], store.project),
      source_ids: [store.instructionId],
      explanation: 'The successor replaced it after the migration review.',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    work: CLOUD_ONLY,
    secretAllow: [],
  });
  const row = read(store.handle, (view) => readProjectRelationship(view, relationshipId))!;
  expect(row.authorizationId).not.toBeNull();
  const recorded = read(store.handle, (view) =>
    readProjectAuthorization(view, row.authorizationId as string)
  )!;
  expect(
    (JSON.parse(Buffer.from(recorded.recordHex, 'hex').toString()) as { departs_from: unknown })
      .departs_from
  ).toEqual([{ rule: store.target, how: 'replaces', exception_id: null, replaced_by: successor }]);

  const revocation = await revoke(store, row.authorizationId as string);
  const entry = resolved(store).relationships[0]!;
  expect(entry).toMatchObject({ standing: 'established', applied: true });
  expect(entry.authority_revoked_by).toEqual([revocation.value.revocationId]);
});

it('records no authorization for an act published on anything but an embedded instruction', async () => {
  const store = await authorityStore();
  const binding = {
    binding_id: uuidv7(),
    approval: {
      source_plan_ref: 'cloud:example-plan',
      version: '2',
      plan_content_sha256: 'a'.repeat(64),
    },
    targets: [
      {
        target: { kind: 'revision', revision: store.target },
        scope: store.project,
        designation: 'adopted',
      },
    ],
    departures: [],
    authorization_evidence_source_id: store.instructionId,
  };
  await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding,
    approvedBy: OWNER,
    secretAllow: [],
  });
  const selection = acceptedSelection(store.target, store.project, {
    kind: 'approval_binding',
    binding_id: binding.binding_id,
  });
  const before = counters(store.handle);
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(
    read(store.handle, (view) => readProjectSelection(view, selection.selection_id))!
      .authorizationId
  ).toBeNull();
  expect(rowCount(store.handle, 'knowledge_authorizations')).toBe(0);
  expect(counters(store.handle).writeSequence).toBe(before.writeSequence + 1);
});

it('records the footprint the store judged, not the one the act carried', async () => {
  const store = await authorityStore();
  const first = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: first,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const successor = await successorRevision(store);
  // The act's own record departs from nothing; the store finds the revision it stands beside and
  // holds the instruction to acknowledging it, so that departure is what the authorization carries.
  const beside = acceptedSelection(
    successor,
    store.project,
    informedBy(store.instructionId, [store.target], store.project),
    { expectedState: observing([first.selection_id]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: beside,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const row = read(store.handle, (view) => readProjectSelection(view, beside.selection_id))!;
  const recorded = read(store.handle, (view) =>
    readProjectAuthorization(view, row.authorizationId as string)
  )!;
  expect(JSON.parse(Buffer.from(recorded.recordHex, 'hex').toString())).toMatchObject({
    adopts: [{ revision: successor, designation: 'adopted' }],
    departs_from: [
      { rule: store.target, how: 'stands_beside', exception_id: null, replaced_by: null },
    ],
    restates: [],
  });
});
