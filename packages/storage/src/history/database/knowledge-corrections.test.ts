import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase } from './connection.js';
import {
  appendProjectCorrection,
  listProjectCorrections,
  readProjectCorrection,
} from './knowledge-corrections.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { resolveProjectKnowledge } from './knowledge-standing.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  establishReplacement,
  findingRevision,
  informedBy,
  instructedBy,
  observing,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  BY_AGENT,
  BY_OWNER,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type {
  ExpectationRevisionRef,
  ExpectedState,
  RecordRevisionRef,
} from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

type Store = Awaited<ReturnType<typeof authorityStore>>;

const INSTRUCTIONS = ['informed_instruction', 'explicit_instruction'];

const authoredSha = (action: unknown, attributedTo: unknown) =>
  digest(
    Buffer.from(canonicalJson({ ...(action as object), attributed_to: attributedTo }) as string)
  );

/** An act on an embedded instruction is timed, because it records an authorization of its own. */
const appendInput = (action: unknown, attributedTo: unknown) => ({
  operationId: uuidv7(),
  action,
  attributedTo: attributedTo as never,
  ...(INSTRUCTIONS.includes(
    ((action as { authorization?: { kind?: string } }).authorization ?? {}).kind ?? ''
  )
    ? { recordedAt: AT }
    : {}),
  secretAllow: [],
});

const append = (store: Store, action: unknown, attributedTo: unknown = BY_OWNER) =>
  appendProjectCorrection(store.handle, appendInput(action, attributedTo));

const base = (store: Store, targets: RecordRevisionRef[], expected?: ExpectedState) => ({
  action_id: uuidv7(),
  targets,
  scope: store.project,
  source_id: store.instructionId,
  authorization: null,
  expected_state: expected ?? ({ kind: 'initial' } as ExpectedState),
});

const challenge = (store: Store, expected?: ExpectedState) => ({
  ...base(store, [store.target], expected),
  kind: 'challenge',
  explanation: 'Offline capture may be unaffordable on the smallest devices.',
});

/** The requirement adopted, so an act that stops it standing has something to stop. */
async function adopted(store: Store) {
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
    secretAllow: [],
  });
  return selection.selection_id;
}

const withdrawal = (store: Store, expected: ExpectedState, target = store.target) => ({
  ...base(store, [target], expected),
  kind: 'withdrawal',
  authorization: informedBy(store.instructionId, [target as ExpectationRevisionRef], store.project),
  reason: 'Offline capture is no longer a product promise.',
});

const standingOf = (store: Store, revisionId: string) =>
  read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      store.project,
      {}
    )
  ).revisions.find((entry) => entry.revision.revision_id === revisionId)?.standing;

it('appends a challenge as a proposal that changes nothing that stands', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const action = challenge(store, observing([selectionId]));
  const before = counters(store.handle);
  const appended = await append(store, action);

  expect(appended.value).toMatchObject({
    actionId: action.action_id,
    kind: 'challenge',
    changeClass: 'proposal',
    changedWhatStands: false,
    authorizationId: null,
  });
  expect(appended.value.recordSha256).toBe(authoredSha(action, BY_OWNER));
  // A correction of any kind by an actor is a change of intent, an unaccepted challenge included.
  expect(appended.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  const row = read(store.handle, (view) => readProjectCorrection(view, action.action_id))!;
  expect(row).toMatchObject({
    kind: 'challenge',
    scope: { kind: 'project', value: null },
    attributedTo: { kind: 'actor', identity: OWNER.identity, basis: OWNER.basis },
    authorizationKind: null,
    authorizationId: null,
    followsActionId: null,
    resultingSelectionKind: null,
    adopted: null,
    changeClass: 'proposal',
    changedWhatStands: false,
    targets: [{ kind: 'requirement', entityId: store.requirementId, revisionId: store.revisionId }],
  });
  expect(JSON.parse(Buffer.from(row.recordHex, 'hex').toString())).toEqual({
    ...action,
    attributed_to: BY_OWNER,
  });
  expect(standingOf(store, store.revisionId)).toBe('stands');
});

it('keeps a detector to a proposal and moves no intent counter for it', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const before = counters(store.handle);
  const appended = await append(store, challenge(store, observing([selectionId])), DETECTOR);
  expect(appended.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  await expect(
    append(store, withdrawal(store, observing([selectionId])), DETECTOR)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'correction_actions')).toBe(1);
});

it('appends each proposing kind, and none of them changes what stands', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const finding = await findingRevision(store);
  const observed = observing([selectionId]);
  const proposals = {
    challenge: challenge(store, observed),
    // A finding is an identity of its own, and nothing governs it yet.
    factual_correction: {
      ...base(store, [finding]),
      kind: 'factual_correction',
      corrected_account: 'The defect was observed on the previous build, not this one.',
    },
    identity_correction: {
      ...base(store, [store.target], observed),
      kind: 'identity_correction',
      mistaken_predecessor: finding,
      intended_interpretation: 'The rule was read as continuing the wrong record.',
    },
    use_correction: {
      ...base(store, [store.target], observed),
      kind: 'use_correction',
      mistaken_use: {
        artifact_id: store.plan.artifactId,
        plan_event_id: store.plan.planEventId,
        target: store.target,
      },
      intended_interpretation: 'The export task never relied on offline capture.',
    },
  };
  for (const [kind, action] of Object.entries(proposals)) {
    const appended = await append(store, action);
    expect(appended.value, kind).toMatchObject({ kind, changedWhatStands: false });
  }
  expect(
    read(store.handle, (view) =>
      listProjectCorrections(view, { kind: 'requirement', entityId: store.requirementId })
    ).map((row) => [row.kind, row.changeClass])
  ).toEqual([
    ['challenge', 'proposal'],
    ['identity_correction', 'proposal'],
    ['use_correction', 'proposal'],
  ]);
  expect(standingOf(store, store.revisionId)).toBe('stands');
  // A correction about a finding is a correction of an account, never a change of intent.
  expect(
    read(store.handle, (view) =>
      listProjectCorrections(view, { kind: 'claim', entityId: finding.entity_id })
    ).map((row) => row.changeClass)
  ).toEqual(['factual_correction']);
});

it('withdraws an adopted requirement and records that it changed what stands', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const action = withdrawal(store, observing([selectionId]));
  const appended = await append(store, action);

  expect(appended.value).toMatchObject({
    changeClass: 'intent_change',
    changedWhatStands: true,
  });
  expect(appended.value.authorizationId).not.toBeNull();
  expect(standingOf(store, store.revisionId)).toBe('stopped');
  const row = read(store.handle, (view) => readProjectCorrection(view, action.action_id))!;
  expect(row.authorizationKind).toBe('informed_instruction');
  expect(row.authorizationId).toBe(appended.value.authorizationId);
});

it('replaces a revision with its successor and makes the successor stand', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const successor = await successorRevision(store);
  const action = {
    ...base(store, [store.target], observing([selectionId])),
    kind: 'accepted_replacement',
    replacement: successor,
    designation: 'adopted',
    authorization: informedBy(store.instructionId, [store.target], store.project),
  };
  const appended = await append(store, action);
  expect(appended.value).toMatchObject({ changeClass: 'intent_change', changedWhatStands: true });
  expect(standingOf(store, store.revisionId)).toBe('stopped');
  expect(standingOf(store, successor.revision_id)).toBe('stands');
  expect(
    read(store.handle, (view) => readProjectCorrection(view, action.action_id))!.adopted
  ).toEqual({
    kind: 'requirement',
    entityId: store.requirementId,
    revisionId: successor.revision_id,
  });
});

it('accepts a proposal and refuses an acceptance of something that was never one', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const proposed = challenge(store, observing([selectionId]));
  await append(store, proposed);
  const acceptance = {
    ...base(store, [store.target], observing([selectionId])),
    kind: 'acceptance',
    accepts_action_id: proposed.action_id,
    authorization: informedBy(store.instructionId, [store.target], store.project),
  };
  const appended = await append(store, acceptance);
  expect(appended.value).toMatchObject({ changeClass: 'intent_change', changedWhatStands: true });
  // An accepted challenge changes recorded standing; the revision still stands.
  expect(standingOf(store, store.revisionId)).toBe('stands');

  const withdrawn = withdrawal(store, observing([selectionId], [acceptance.action_id]));
  await append(store, withdrawn);
  await expect(
    append(store, {
      ...base(store, [store.target], observing([], [acceptance.action_id, withdrawn.action_id])),
      kind: 'acceptance',
      accepts_action_id: withdrawn.action_id,
      authorization: informedBy(store.instructionId, [store.target], store.project),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'correction_actions')).toBe(3);
});

it('reverses a withdrawal, restores the revision it names, and reverses that reversal', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const withdrawn = withdrawal(store, observing([selectionId]));
  await append(store, withdrawn);
  expect(standingOf(store, store.revisionId)).toBe('stopped');

  const restoring = {
    ...base(store, [store.target], observing([], [withdrawn.action_id])),
    kind: 'reversal',
    reverses_action_id: withdrawn.action_id,
    resulting_selection: {
      kind: 'revision',
      revision: store.target,
      designation: 'adopted',
    },
    authorization: informedBy(store.instructionId, [store.target], store.project),
  };
  const reversed = await append(store, restoring);
  expect(reversed.value).toMatchObject({ changedWhatStands: true });
  expect(standingOf(store, store.revisionId)).toBe('stands');
  expect(
    read(store.handle, (view) => readProjectCorrection(view, restoring.action_id))!
  ).toMatchObject({
    followsActionId: withdrawn.action_id,
    resultingSelectionKind: 'revision',
    adoptedDesignation: 'adopted',
  });

  const undone = {
    ...base(store, [store.target], observing([], [withdrawn.action_id, restoring.action_id])),
    kind: 'reversal',
    reverses_action_id: restoring.action_id,
    resulting_selection: { kind: 'none' },
    authorization: informedBy(store.instructionId, [store.target], store.project),
  };
  await append(store, undone);
  expect(standingOf(store, store.revisionId)).toBe('stopped');
});

it('refuses a reversal that restores what the action it follows never departed from', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const successor = await successorRevision(store);
  const withdrawn = withdrawal(store, observing([selectionId]));
  await append(store, withdrawn);
  const before = counters(store.handle);
  await expect(
    append(store, {
      ...base(store, [store.target], observing([], [withdrawn.action_id])),
      kind: 'reversal',
      reverses_action_id: withdrawn.action_id,
      resulting_selection: { kind: 'revision', revision: successor, designation: 'adopted' },
      authorization: informedBy(store.instructionId, [store.target, successor], store.project),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'correction_actions')).toBe(1);
});

it("refuses undoing another's act with no instruction and accepts it with one in scope", async () => {
  const store = await authorityStore();
  const proposed = challenge(store);
  await append(store, proposed, BY_AGENT);
  const reversal = (authorization: unknown) => ({
    ...base(store, [store.target]),
    kind: 'reversal',
    reverses_action_id: proposed.action_id,
    resulting_selection: { kind: 'none' },
    authorization,
  });
  await expect(append(store, reversal(null))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const instructed = reversal(instructedBy(store.instructionId, store.project));
  const appended = await append(store, instructed);
  // The act authorizes nothing, so there is no authorization to record for it and none to name.
  expect(appended.value.authorizationId).toBeNull();
  expect(
    read(store.handle, (view) => readProjectCorrection(view, instructed.action_id))!
      .authorizationKind
  ).toBe('explicit_instruction');
  expect(rowCount(store.handle, 'knowledge_authorizations')).toBe(0);
});

it('refuses an act that would follow a longer chain than one act may follow', async () => {
  const store = await authorityStore();
  const proposed = challenge(store);
  await append(store, proposed, BY_AGENT);
  let followed = proposed.action_id;
  const reversalOf = (actionId: string) => ({
    ...base(store, [store.target]),
    kind: 'reversal',
    reverses_action_id: actionId,
    resulting_selection: { kind: 'none' },
  });
  // The contract's bound is 64 links, so the sixty-fourth reversal is the last one that may follow.
  for (let link = 0; link < 64; link += 1) {
    const action = reversalOf(followed);
    await append(store, action, BY_AGENT);
    followed = action.action_id;
  }
  const before = counters(store.handle);
  await expect(append(store, reversalOf(followed), BY_AGENT)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'correction_actions')).toBe(65);
});

it('refuses a second act following an action that already has a standing follower', async () => {
  const store = await authorityStore();
  const proposed = challenge(store);
  await append(store, proposed, BY_AGENT);
  const retraction = {
    ...base(store, [store.target]),
    kind: 'reversal',
    reverses_action_id: proposed.action_id,
    resulting_selection: { kind: 'none' },
  };
  await append(store, retraction, BY_AGENT);
  const second = {
    ...retraction,
    action_id: uuidv7(),
  };
  await expect(append(store, second, BY_AGENT)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  // A follower that was itself reversed no longer counts, so the act becomes possible again.
  await append(
    store,
    {
      ...base(store, [store.target]),
      kind: 'reversal',
      reverses_action_id: retraction.action_id,
      resulting_selection: { kind: 'none' },
    },
    BY_AGENT
  );
  expect((await append(store, second, BY_AGENT)).value.actionId).toBe(second.action_id);
});

it('refuses references this history does not hold and writes nothing', async () => {
  const store = await authorityStore();
  const absent = { ...store.target, revision_id: uuidv7() };
  const noRelationship = uuidv7();
  const before = counters(store.handle);
  for (const action of [
    { ...challenge(store), targets: [absent] },
    { ...challenge(store), source_id: uuidv7() },
    {
      ...base(store, [store.target]),
      kind: 'acceptance',
      accepts_action_id: uuidv7(),
      authorization: informedBy(store.instructionId, [store.target], store.project),
    },
    {
      ...base(store, [
        {
          kind: 'relationship',
          entity_id: noRelationship,
          revision_id: noRelationship,
        } as RecordRevisionRef,
      ]),
      kind: 'withdrawal',
      reason: 'No such relationship was ever retained.',
    },
  ])
    await expect(append(store, action)).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(store.handle, 'correction_actions')).toBe(0);
  expect(counters(store.handle)).toEqual(before);
});

it('refuses a foreign project id and a branch as an authority scope', async () => {
  const store = await authorityStore();
  for (const scope of [
    { kind: 'project', project_id: uuidv7() },
    { kind: 'branch', branch: 'feature/retry' },
  ])
    await expect(append(store, { ...challenge(store), scope })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  expect(rowCount(store.handle, 'correction_actions')).toBe(0);
});

it('replays the original result under the same operation id and refuses a changed field', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const action = withdrawal(store, observing([selectionId]));
  const input = appendInput(action, BY_OWNER);
  const first = await appendProjectCorrection(store.handle, input);
  const before = counters(store.handle);
  expect(await appendProjectCorrection(store.handle, input)).toEqual({ ...first, replayed: true });
  expect(counters(store.handle)).toEqual(before);
  for (const changed of [
    { action: { ...action, reason: 'Another reason entirely.' } },
    { recordedAt: '2026-09-18T10:00:00.000Z' },
  ])
    await expect(
      appendProjectCorrection(store.handle, { ...input, ...changed })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'correction_actions')).toBe(1);
});

it('fails a stale expected state atomically, with the state that governs now', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const withdrawn = withdrawal(store, observing([selectionId]));
  await append(store, withdrawn);
  const second = await openProjectDatabase({ authority: store.authority, mode: 'writer' });
  try {
    const before = counters(second);
    await expect(
      appendProjectCorrection(
        second,
        appendInput(challenge(store, observing([selectionId])), BY_OWNER)
      )
    ).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
      current: { selection_ids: [], correction_action_ids: [withdrawn.action_id] },
    });
    expect(counters(second)).toEqual(before);
    expect(rowCount(second, 'correction_actions')).toBe(1);
  } finally {
    second.close();
  }
});

it('lets one of two processes correct against the same observed state and refuses the other as stale', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const candidate = fileURLToPath(new URL('../../../../../', import.meta.url));
  const script = path.join(candidate, 'packages/storage/tests/correction-race.mjs');
  const racers = [0, 1].map(
    () =>
      new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            script,
            candidate,
            JSON.stringify({
              authority: store.authority,
              operationId: uuidv7(),
              action: withdrawal(store, observing([selectionId])),
              attributedTo: BY_OWNER,
              recordedAt: AT,
            }),
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] }
        );
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.on('error', reject);
        child.on('close', () => resolve(JSON.parse(out || '{"ok":false,"code":"NO_OUTPUT"}')));
      })
  );
  const results = await Promise.all(racers);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => result.code === 'STALE_CONTEXT')).toHaveLength(1);
  expect(rowCount(store.handle, 'correction_actions')).toBe(1);
});

it('lets a replaced revision be adopted again once the replacement is withdrawn', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const relationshipId = await establishReplacement(store.handle, {
    from: successor,
    to: store.target,
    scope: store.project,
    sourceId: store.instructionId,
  });
  const adopting = (expectedState?: ExpectedState) =>
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        store.target,
        store.project,
        instructedBy(store.instructionId, store.project),
        { expectedState }
      ),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    });
  // The refusal names the relationship to withdraw, which is how an act is told what to do first.
  await expect(adopting()).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining(relationshipId),
  });

  const withdrawn = {
    ...base(store, [
      { kind: 'relationship', entity_id: relationshipId, revision_id: relationshipId },
    ]),
    kind: 'withdrawal',
    authorization: informedBy(store.instructionId, [successor], store.project),
    reason: 'The successor was recorded against the wrong revision.',
  };
  await append(store, withdrawn);
  // Withdrawing the replacement changed what stands for the requirement, so the adoption that
  // follows it observes that act and no earlier state.
  await expect(adopting()).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect((await adopting(observing([], [withdrawn.action_id]))).value.recordedIn).toBe('adoptions');
});

it('reaches a finding inside its own artifact and nowhere else without an instruction', async () => {
  const store = await authorityStore();
  const finding = await findingRevision(store);
  const inItsArtifact = {
    ...base(store, [finding]),
    scope: store.artifact,
    kind: 'withdrawal',
    reason: 'The finding was recorded against the wrong build.',
  };
  const appended = await append(store, inItsArtifact);
  expect(appended.value).toMatchObject({ changeClass: 'factual_correction' });

  const elsewhere = {
    ...base(store, [await findingRevision(store, 'A second finding.')]),
    scope: { kind: 'artifact', artifact_id: uuidv7() },
    kind: 'withdrawal',
    reason: 'Reusing a finding elsewhere grants nothing over its source.',
  };
  await expect(append(store, elsewhere)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'correction_actions')).toBe(1);
});

it('refuses a reversal that would restore a revision a standing replacement points at', async () => {
  const store = await authorityStore();
  const selectionId = await adopted(store);
  const withdrawn = withdrawal(store, observing([selectionId]));
  await append(store, withdrawn);
  const successor = await successorRevision(store);
  const relationshipId = await establishReplacement(store.handle, {
    from: successor,
    to: store.target,
    scope: store.project,
    sourceId: store.instructionId,
  });
  const restoring = (expected: ExpectedState) => ({
    ...base(store, [store.target], expected),
    kind: 'reversal',
    reverses_action_id: withdrawn.action_id,
    resulting_selection: { kind: 'revision', revision: store.target, designation: 'adopted' },
    authorization: informedBy(store.instructionId, [store.target], store.project),
  });
  const before = counters(store.handle);
  await expect(
    append(store, restoring(observing([], [withdrawn.action_id])))
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining(relationshipId),
  });
  expect(counters(store.handle)).toEqual(before);
  expect(standingOf(store, store.revisionId)).toBe('stopped');

  const withdrawnRelationship = {
    ...base(store, [
      { kind: 'relationship', entity_id: relationshipId, revision_id: relationshipId },
    ]),
    kind: 'withdrawal',
    authorization: informedBy(store.instructionId, [successor], store.project),
    reason: 'The successor was recorded against the wrong revision.',
  };
  await append(store, withdrawnRelationship);
  await append(
    store,
    restoring(observing([], [withdrawn.action_id, withdrawnRelationship.action_id]))
  );
  expect(standingOf(store, store.revisionId)).toBe('stands');
});

it('refuses an accepted replacement whose replacement a standing replacement points at', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const relationshipId = await establishReplacement(store.handle, {
    from: successor,
    to: store.target,
    scope: store.project,
    sourceId: store.instructionId,
  });
  // Putting the replaced revision back in place of its successor is the same contradiction.
  const replacing = (expected: ExpectedState) => ({
    ...base(store, [successor], expected),
    kind: 'accepted_replacement',
    replacement: store.target,
    designation: 'adopted',
    authorization: informedBy(store.instructionId, [successor], store.project),
  });
  const before = counters(store.handle);
  await expect(append(store, replacing({ kind: 'initial' }))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining(relationshipId),
  });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'correction_actions')).toBe(0);

  const withdrawnRelationship = {
    ...base(store, [
      { kind: 'relationship', entity_id: relationshipId, revision_id: relationshipId },
    ]),
    kind: 'withdrawal',
    authorization: informedBy(store.instructionId, [successor], store.project),
    reason: 'The successor was recorded against the wrong revision.',
  };
  await append(store, withdrawnRelationship);
  const appended = await append(store, replacing(observing([], [withdrawnRelationship.action_id])));
  expect(appended.value.changedWhatStands).toBe(true);
  expect(standingOf(store, store.revisionId)).toBe('stands');
});
