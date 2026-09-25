// Assignments through real project databases: what an assigner may delegate, what an act under one
// may do, and what a revocation ends.
import { afterEach, expect, it } from 'vitest';

import { type ProjectReadView } from './connection.js';
import { publishProjectApprovalBinding } from './knowledge-approval-bindings.js';
import {
  type AssignmentReadRequest,
  listProjectAssignments,
  publishProjectAssignment,
  readProjectAssignment,
} from './knowledge-assignments.js';
import { appendProjectCorrection } from './knowledge-corrections.js';
import { publishProjectException } from './knowledge-exceptions.js';
import { knowledgeBoundaryAt, knowledgeReadRequest } from './knowledge-read-boundary.js';
import { publishProjectRevocation } from './knowledge-revocations.js';
import { publishProjectSelection } from './knowledge-selections.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  informedBy,
  instructedBy,
  observing,
  revokeDirectly,
  successorRevision,
  withdrawRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  AGENT,
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type {
  Actor,
  AuthorityScope,
  ExpectationRevisionRef,
  RecordRevisionRef,
} from '../../schema/knowledge-contract.js';

afterEach(discardKnowledgeStores);

type Store = Awaited<ReturnType<typeof authorityStore>>;

const BEFORE_IT_ENDS = { time: '2026-11-30T00:00:00.000Z' };
const AFTER_IT_ENDS = { time: '2026-12-02T00:00:00.000Z' };
const ENDS_AT = '2026-12-01T00:00:00.000Z';

const restingOn = (assignmentId: string) => ({
  kind: 'assignment' as const,
  assignment_id: assignmentId,
});

const adopting = (revision: RecordRevisionRef, designation = 'adopted') => ({
  adopts: [{ revision, designation }],
  departs_from: [],
  restates: [],
});

const excepting = (rule: ExpectationRevisionRef, exceptionId: string) => ({
  adopts: [],
  departs_from: [{ rule, how: 'excepts', exception_id: exceptionId, replaced_by: null }],
  restates: [],
});

const assignment = (
  store: Store,
  change: {
    id?: string;
    objective?: string;
    inherited?: unknown[];
    delegated?: unknown;
    responsible?: unknown;
    scope?: AuthorityScope;
    authorization?: unknown;
    validUntil?: string | null;
  } = {}
) => ({
  assignment_id: change.id ?? uuidv7(),
  objective: change.objective ?? 'Make upload retries idempotent.',
  inherited: change.inherited ?? [],
  delegated: change.delegated ?? adopting(store.target),
  allowed_changes: ['Retry scheduling and backoff inside the upload queue.'],
  escalation_conditions: ['Any change to what is captured while offline.'],
  responsible: change.responsible ?? AGENT,
  source_id: store.instructionId,
  scope: change.scope ?? store.project,
  authorization:
    change.authorization ?? informedBy(store.instructionId, [store.target], store.project),
  valid_until: change.validUntil ?? null,
});

const open = (store: Store, authored: ReturnType<typeof assignment>, work: unknown = {}) =>
  publishProjectAssignment(store.handle, {
    operationId: uuidv7(),
    assignment: authored,
    assignedBy: OWNER,
    work,
    secretAllow: [],
  });

const requestIn = (
  view: ProjectReadView,
  store: Store,
  boundary: number | 'now' = 'now',
  judgedAt?: string
) =>
  knowledgeReadRequest(view, {
    scope: store.project,
    mode: boundary === 'now' ? 'current' : 'historical',
    boundary,
    ...(judgedAt === undefined ? {} : { exceptionsJudgedAt: judgedAt }),
  });

const held = (store: Store, assignmentId: string) =>
  read(store.handle, (view) =>
    readProjectAssignment(view, store.authority.projectId, assignmentId, requestIn(view, store))
  );

/** The store's requirement adopted, so a rule an assignment rests on actually stands. */
const adoptTarget = async (store: Store) => {
  const adoption = acceptedSelection(
    store.target,
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
  return adoption.selection_id;
};

const adoptionRow = (store: Store, adoptionId: string) =>
  read(store.handle, (view) =>
    view.get<Record<string, unknown>>('SELECT * FROM adoptions WHERE adoption_id=?', adoptionId)
  );

const listed = (
  store: Store,
  boundary: number | 'now' = 'now',
  judgedAt?: string,
  input: AssignmentReadRequest = {}
) =>
  read(store.handle, (view) =>
    listProjectAssignments(
      view,
      store.authority.projectId,
      requestIn(view, store, boundary, judgedAt),
      input
    )
  );

it('retains what an assignment delegates, the identities it names, and who is responsible', async () => {
  const store = await authorityStore();
  await adoptTarget(store);
  const authored = assignment(store, { inherited: [store.target] });
  const before = counters(store.handle);
  const published = await open(store, authored);
  expect(published.value).toEqual({
    assignmentId: authored.assignment_id,
    responsible: AGENT.identity,
    recordSha256: expect.any(String),
  });
  // It designates nothing: the acts published under it are what change what stands.
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const row = held(store, authored.assignment_id)!;
  expect(row.record).toEqual({ ...authored, assigned_by: OWNER });
  expect(row).toMatchObject({
    objective: 'Make upload retries idempotent.',
    responsible: { identity: AGENT.identity, basis: AGENT.basis },
    assignedBy: { identity: OWNER.identity, basis: OWNER.basis },
    scope: { kind: 'project', value: null },
    authorizationKind: 'informed_instruction',
    sourceId: store.instructionId,
    validUntil: null,
    standing: 'valid',
  });
  expect(
    read(store.handle, (view) =>
      view.all<{ member_kind: string; member_id: string }>(
        'SELECT member_kind, member_id FROM assignment_members WHERE assignment_id=?',
        authored.assignment_id
      )
    )
  ).toEqual([{ member_kind: 'requirement', member_id: store.requirementId }]);
});

it('refuses an assignment whose inherited revision has never stood', async () => {
  const store = await authorityStore();
  const inherited = await successorRevision(store);
  const before = counters(store.handle);
  const beforeSources = rowCount(store.handle, 'knowledge_sources');

  await expect(open(store, assignment(store, { inherited: [inherited] }))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining(`revision ${inherited.revision_id}`),
  });

  expect(rowCount(store.handle, 'assignments')).toBe(0);
  expect(rowCount(store.handle, 'assignment_members')).toBe(0);
  expect(rowCount(store.handle, 'knowledge_sources')).toBe(beforeSources);
  expect(counters(store.handle)).toEqual(before);
});

it('refuses a delegated departure from a rule the assigner’s instruction never acknowledged', async () => {
  const store = await authorityStore();
  const other: ExpectationRevisionRef = {
    kind: 'decision',
    entity_id: uuidv7(),
    revision_id: uuidv7(),
  };
  await expect(
    open(
      store,
      assignment(store, {
        delegated: {
          adopts: [],
          departs_from: [{ rule: other, how: 'withdraws', exception_id: null, replaced_by: null }],
          restates: [],
        },
      })
    )
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('acknowledges'),
  });
  expect(rowCount(store.handle, 'assignments')).toBe(0);
  expect(rowCount(store.handle, 'assignment_members')).toBe(0);
});

it('refuses an assignment that delegates nothing at all', async () => {
  const store = await authorityStore();
  await expect(
    open(store, assignment(store, { delegated: { adopts: [], departs_from: [], restates: [] } }))
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('adopts nothing'),
  });
  expect(rowCount(store.handle, 'assignments')).toBe(0);
});

it('delegates only what an approval binding approved', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const bindingId = uuidv7();
  await publishProjectApprovalBinding(store.handle, {
    operationId: uuidv7(),
    binding: {
      binding_id: bindingId,
      approval: {
        source_plan_ref: 'cloud:example-plan',
        version: '2',
        plan_content_sha256: 'a'.repeat(64),
      },
      targets: [
        {
          target: { kind: 'revision', revision: successor },
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
  const approved = { kind: 'approval_binding', binding_id: bindingId };
  await expect(
    open(store, assignment(store, { authorization: approved, delegated: adopting(store.target) }))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'assignments')).toBe(0);
  const within = assignment(store, {
    authorization: approved,
    delegated: adopting(successor),
    inherited: [],
  });
  expect((await open(store, within)).value.assignmentId).toBe(within.assignment_id);
});

it('lets a chain of assignments narrow and never widen', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const other = await successorRevision(store, 'Local capture keeps a durable queue.');
  const first = assignment(store, { delegated: adopting(successor), inherited: [] });
  await open(store, first);
  const chained = (change: Parameters<typeof assignment>[1]) =>
    publishProjectAssignment(store.handle, {
      operationId: uuidv7(),
      assignment: assignment(store, {
        authorization: restingOn(first.assignment_id),
        inherited: [],
        responsible: OWNER,
        ...change,
      }),
      // The second assigner is the first assignment's responsible party, which is the only
      // identity an act under it may claim.
      assignedBy: AGENT,
      secretAllow: [],
    });
  const narrowed = await chained({ delegated: adopting(successor) });
  expect(narrowed.value.responsible).toBe(OWNER.identity);
  await expect(chained({ delegated: adopting(other) })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('delegates no such adoption'),
  });
  await expect(chained({ delegated: adopting(successor, 'background') })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  // The same chain attempted by somebody the first assignment never made responsible.
  await expect(
    publishProjectAssignment(store.handle, {
      operationId: uuidv7(),
      assignment: assignment(store, {
        authorization: restingOn(first.assignment_id),
        inherited: [],
        delegated: adopting(successor),
      }),
      assignedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('responsible'),
  });
  expect(rowCount(store.handle, 'assignments')).toBe(2);
});

it('publishes an adoption inside what an assignment delegates and records what it rested on', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const authored = assignment(store, { delegated: adopting(successor), inherited: [] });
  await open(store, authored);
  const adoption = acceptedSelection(successor, store.project, restingOn(authored.assignment_id));
  const published = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: adoption,
    selectedBy: AGENT,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(published.value.recordedIn).toBe('adoptions');
  // Only an act under an embedded instruction records an authorization of its own; an act under an
  // assignment names the assignment in its own authorization, which is how a revocation reaches it.
  expect(
    read(store.handle, (view) =>
      view.get<{ authorization_json: string; authorization_id: string | null }>(
        'SELECT authorization_json, authorization_id FROM adoptions WHERE adoption_id=?',
        adoption.selection_id
      )
    )
  ).toEqual({
    authorization_json: JSON.stringify({
      assignment_id: authored.assignment_id,
      kind: 'assignment',
    }),
    authorization_id: null,
  });
});

it('publishes an exception the assignment delegates and refuses one it does not', async () => {
  const store = await authorityStore();
  const adoptionId = await adoptTarget(store);
  const exceptionId = uuidv7();
  const authored = assignment(store, {
    delegated: excepting(store.target, exceptionId),
    authorization: informedBy(store.instructionId, [store.target], store.project),
  });
  await open(store, authored);
  const exception = (id: string) => ({
    exception_id: id,
    expectation: store.target,
    context: {
      all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['upload-retry'] }],
    },
    scope: store.project,
    rationale: 'Retries may re-send a capture the queue already holds.',
    source_id: store.instructionId,
    authorization: restingOn(authored.assignment_id),
    ends: { kind: 'until_revoked' },
    end_behavior: 'expectation_applies_again',
    expected_state: {
      kind: 'observed',
      selection_ids: [adoptionId],
      correction_action_ids: [],
    },
  });
  const published = await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: exception(exceptionId),
    grantedBy: AGENT,
    secretAllow: [],
  });
  expect(published.value.exceptionId).toBe(exceptionId);
  expect(
    read(store.handle, (view) =>
      view.get<{ authorization_kind: string }>(
        'SELECT authorization_kind FROM knowledge_exceptions WHERE exception_id=?',
        exceptionId
      )
    )
  ).toEqual({ authorization_kind: 'assignment' });
  // A different exception to the same rule is a different departure, so the assignment covers it
  // no more than it covers withdrawing the rule outright.
  await expect(
    publishProjectException(store.handle, {
      operationId: uuidv7(),
      exception: exception(uuidv7()),
      grantedBy: AGENT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('delegates no such departure'),
  });
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(1);
});

it('publishes a correction acceptance the assignment delegates', async () => {
  const store = await authorityStore();
  const adoptionId = await adoptTarget(store);
  const correcting = {
    rule: store.target,
    how: 'corrects',
    exception_id: null,
    replaced_by: null,
  };
  const authored = assignment(store, {
    delegated: { adopts: [], departs_from: [correcting], restates: [] },
    authorization: informedBy(store.instructionId, [store.target], store.project),
  });
  await open(store, authored);
  const challenge = {
    action_id: uuidv7(),
    kind: 'challenge',
    targets: [store.target],
    scope: store.project,
    source_id: store.instructionId,
    authorization: null,
    expected_state: observing([adoptionId]),
    explanation: 'The offline promise was never true of the retry queue.',
  };
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: challenge,
    attributedTo: { kind: 'actor', actor: AGENT },
    secretAllow: [],
  });
  const accepted = await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: uuidv7(),
      kind: 'acceptance',
      targets: [store.target],
      scope: store.project,
      source_id: store.instructionId,
      authorization: restingOn(authored.assignment_id),
      expected_state: observing([adoptionId]),
      accepts_action_id: challenge.action_id,
    },
    attributedTo: { kind: 'actor', actor: AGENT },
    secretAllow: [],
  });
  expect(
    read(store.handle, (view) =>
      view.get<{ authorization_kind: string; authorization_id: string | null }>(
        'SELECT authorization_kind, authorization_id FROM correction_actions WHERE action_id=?',
        accepted.value.actionId
      )
    )
  ).toEqual({ authorization_kind: 'assignment', authorization_id: null });
});

it('refuses an act outside what the assignment delegates and an act by anyone else', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const authored = assignment(store, { delegated: adopting(successor), inherited: [] });
  await open(store, authored);
  const adopt = (target: ExpectationRevisionRef, actor: Actor = AGENT) =>
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(target, store.project, restingOn(authored.assignment_id)),
      selectedBy: actor,
      acceptedAt: AT,
      secretAllow: [],
    });
  await expect(adopt(store.target)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('delegates no such adoption'),
  });
  await expect(adopt(successor, OWNER)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('does not claim the identity'),
  });
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('refuses an act after the assignment ends, and one whose time cannot be judged', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const authored = assignment(store, {
    delegated: adopting(successor),
    inherited: [],
    validUntil: ENDS_AT,
  });
  await open(store, authored);
  const adopt = (work: unknown) =>
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(successor, store.project, restingOn(authored.assignment_id)),
      selectedBy: AGENT,
      acceptedAt: AT,
      work,
      secretAllow: [],
    });
  for (const work of [AFTER_IT_ENDS, {}])
    await expect(adopt(work)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('at the time the act was judged at'),
    });
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
  expect((await adopt(BEFORE_IT_ENDS)).value.recordedIn).toBe('adoptions');
});

it('ends every later act on revocation and leaves the earlier act and the assignment as they were', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const authored = assignment(store, { delegated: adopting(successor), inherited: [] });
  await open(store, authored);
  const first = acceptedSelection(successor, store.project, restingOn(authored.assignment_id));
  const published = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: first,
    selectedBy: AGENT,
    acceptedAt: AT,
    secretAllow: [],
  });
  const boundaryBefore = read(store.handle, knowledgeBoundaryAt);
  const adoptedBefore = adoptionRow(store, first.selection_id);
  const rowBefore = held(store, authored.assignment_id)!;
  const before = counters(store.handle);
  const revocation = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: {
      revocation_id: uuidv7(),
      revokes: { kind: 'assignment', id: authored.assignment_id },
      scope: store.project,
      source_id: store.instructionId,
      instruction: instructedBy(store.instructionId, store.project),
      recorded_at: AT,
    },
    revokedBy: OWNER,
    secretAllow: [],
  });
  // Ending a delegation designates nothing: it moves the write sequence and not the intent counter.
  expect(revocation.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(successor, store.project, restingOn(authored.assignment_id), {
        expectedState: observing([first.selection_id]),
      }),
      selectedBy: AGENT,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('was revoked'),
  });
  const rowAfter = held(store, authored.assignment_id)!;
  expect(rowAfter.recordSha256).toBe(rowBefore.recordSha256);
  expect(rowAfter).toMatchObject({
    standing: 'revoked',
    revokedBy: [revocation.value.revocationId],
  });
  expect(published.value.selectionId).toBe(first.selection_id);
  // The act published before the revocation is untouched: revoking ends what comes after it.
  expect(adoptionRow(store, first.selection_id)).toEqual(adoptedBefore);
  expect(rowCount(store.handle, 'adoptions')).toBe(1);
  // A read at the boundary before the revocation is an answer about then, not a shortened answer
  // about now.
  expect(listed(store, boundaryBefore).assignments[0]).toMatchObject({
    standing: 'valid',
    revokedBy: [],
  });
});

it('ends an assignment only where the revoking scope reaches', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const authored = assignment(store, { delegated: adopting(successor), inherited: [] });
  await open(store, authored);
  await revokeDirectly(store.handle, {
    revokes: { kind: 'assignment', id: authored.assignment_id },
    scope: store.artifact,
    sourceId: store.instructionId,
  });
  expect(listed(store).assignments[0]).toMatchObject({ standing: 'valid', revokedBy: [] });
  const published = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(successor, store.project, restingOn(authored.assignment_id)),
    selectedBy: AGENT,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(published.value.recordedIn).toBe('adoptions');
});

it('reports an assignment that ends at a time a read named none for as neither valid nor expired', async () => {
  const store = await authorityStore();
  const ending = assignment(store, { validUntil: ENDS_AT });
  await open(store, ending);
  expect(listed(store).assignments[0]?.standing).toBe('not_judgeable');
  expect(listed(store, 'now', AFTER_IT_ENDS.time).assignments[0]?.standing).toBe('expired');
  expect(listed(store, 'now', BEFORE_IT_ENDS.time).assignments[0]?.standing).toBe('valid');
});

it('reports an assignment whose inherited rule no longer stands as one whose basis ended', async () => {
  const store = await authorityStore();
  const adoptionId = await adoptTarget(store);
  const authored = assignment(store, { inherited: [store.target] });
  await open(store, authored);
  expect(listed(store).assignments[0]?.standing).toBe('valid');
  await withdrawRevision(store.handle, {
    target: store.target,
    scope: store.project,
    sourceId: store.instructionId,
    instructionId: store.instructionId,
    expectedState: { kind: 'observed', selection_ids: [adoptionId], correction_action_ids: [] },
  });
  expect(listed(store).assignments[0]?.standing).toBe('basis_ended');
});

it('replays an identical retry and refuses a changed payload under the same operation id', async () => {
  const store = await authorityStore();
  const operationId = uuidv7();
  const input = {
    operationId,
    assignment: assignment(store),
    assignedBy: OWNER,
    secretAllow: [],
  };
  const first = await publishProjectAssignment(store.handle, input);
  const before = counters(store.handle);
  expect(await publishProjectAssignment(store.handle, input)).toEqual({
    ...first,
    replayed: true,
  });
  expect(counters(store.handle)).toEqual(before);
  await expect(
    publishProjectAssignment(store.handle, {
      ...input,
      assignment: { ...input.assignment, objective: 'Something else entirely.' },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'assignments')).toBe(1);
});

it('refuses a secret before anything is written', async () => {
  const store = await authorityStore();
  const secret = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
  await expect(
    open(store, assignment(store, { objective: `Rotate the deploy key ${secret}.` }))
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  expect(rowCount(store.handle, 'assignments')).toBe(0);
});

it('refuses an identity, a source and an assignment id this history does not hold', async () => {
  const store = await authorityStore();
  const absent: ExpectationRevisionRef = { ...store.target, revision_id: uuidv7() };
  await expect(open(store, assignment(store, { inherited: [absent] }))).rejects.toMatchObject({
    code: 'HISTORY_MISSING',
  });
  await expect(
    open(store, assignment(store, { authorization: restingOn(uuidv7()) }))
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  const taken = assignment(store);
  await open(store, taken);
  await expect(open(store, assignment(store, { id: taken.assignment_id }))).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(rowCount(store.handle, 'assignments')).toBe(1);
});

it('lists assignments by responsible party and by the identity they name', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const mine = assignment(store, { delegated: adopting(store.target) });
  const theirs = assignment(store, {
    delegated: adopting(successor),
    inherited: [],
    responsible: OWNER,
  });
  await open(store, mine);
  await open(store, theirs);
  const byResponsible = listed(store, 'now', undefined, { responsible: AGENT.identity });
  expect(byResponsible.assignments.map((row) => row.assignmentId)).toEqual([mine.assignment_id]);
  const byIdentity = listed(store, 'now', undefined, {
    identity: { kind: 'requirement', entityId: store.requirementId },
  });
  expect(byIdentity.assignments.map((row) => row.assignmentId).sort()).toEqual(
    [mine.assignment_id, theirs.assignment_id].sort()
  );
  expect(listed(store).assignments).toHaveLength(2);
  const bounded = listed(store, 'now', undefined, { maxItems: 1 });
  expect([bounded.assignments.length, bounded.truncated]).toEqual([1, 1]);
});

it('shows nothing of an assignment published after the boundary a read names', async () => {
  const store = await authorityStore();
  const boundary = read(store.handle, knowledgeBoundaryAt);
  const authored = assignment(store);
  await open(store, authored);
  expect(
    read(store.handle, (view) =>
      readProjectAssignment(
        view,
        store.authority.projectId,
        authored.assignment_id,
        requestIn(view, store, boundary)
      )
    )
  ).toBeNull();
  const earlier = listed(store, boundary);
  expect([earlier.assignments.length, earlier.later]).toEqual([0, 1]);
});

it('refuses a foreign project id as an authority scope', async () => {
  const store = await authorityStore();
  const scope = { kind: 'project', project_id: uuidv7() } as AuthorityScope;
  await expect(
    open(
      store,
      assignment(store, {
        scope,
        authorization: informedBy(store.instructionId, [store.target], scope),
      })
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'assignments')).toBe(0);
});
