import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase } from './connection.js';
import { publishProjectAuthorization } from './knowledge-authorizations.js';
import { publishProjectRequirementRevision } from './knowledge-requirements.js';
import { publishProjectRevocation } from './knowledge-revocations.js';
import {
  listProjectSelections,
  publishProjectSelection,
  readProjectSelection,
} from './knowledge-selections.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  BY_OWNER,
  establishReplacement,
  informedBy,
  instructedBy,
  observing,
  requirementRevision,
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
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { ExpectationRevisionRef } from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const authoredSha = (selection: unknown, selectedBy: unknown) =>
  digest(
    Buffer.from(canonicalJson({ ...(selection as object), selected_by: selectedBy }) as string)
  );

/** A second revision of the requirement, so a later adoption can stand beside the first. */
async function successor(store: Awaited<ReturnType<typeof authorityStore>>) {
  const revision = requirementRevision(store.requirementId, store.sourceId, {
    previousRevisionId: store.revisionId,
    statement: 'Local capture and local search work with no Cloud connection.',
  });
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return {
    kind: 'requirement',
    entity_id: store.requirementId,
    revision_id: revision.revision_id,
  } as ExpectationRevisionRef;
}

it('writes an accepted selection as an adoption with its scope, designation, approver and authority', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  const before = counters(store.handle);
  const published = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(published.value).toEqual({
    selectionId: selection.selection_id,
    kind: 'accepted',
    recordSha256: authoredSha(selection, OWNER),
    recordedIn: 'adoptions',
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  const row = read(store.handle, (view) => readProjectSelection(view, selection.selection_id))!;
  expect(row).toMatchObject({
    kind: 'accepted',
    target: {
      kind: 'requirement',
      entityId: store.requirementId,
      revisionId: store.revisionId,
    },
    scope: { kind: 'project', value: null },
    designation: 'adopted',
    selectedBy: { identity: OWNER.identity, basis: OWNER.basis },
    acceptedAt: AT,
    sourceRefs: [store.instructionId],
  });
  expect(JSON.parse(row.authorizationJson!)).toEqual(selection.authorization);
  expect(rowCount(store.handle, 'recorded_choices')).toBe(0);
});

it('writes a working choice in its own table, adopts nothing and moves no intent counter', async () => {
  const store = await authorityStore();
  const choice = {
    selection_id: uuidv7(),
    kind: 'working',
    target: store.target,
    scope: store.artifact,
    designation: null,
    authorization: null,
    expected_state: { kind: 'initial' },
  };
  const before = counters(store.handle);
  const published = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: choice,
    selectedBy: AGENT,
    secretAllow: [],
  });
  expect(published.value.recordedIn).toBe('recorded_choices');
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const row = read(store.handle, (view) => readProjectSelection(view, choice.selection_id))!;
  expect(digest(Buffer.from(row.recordHex!, 'hex'))).toBe(row.recordSha256);
  expect(JSON.parse(Buffer.from(row.recordHex!, 'hex').toString())).toEqual({
    ...choice,
    selected_by: AGENT,
  });
  expect(row.scope).toEqual({ kind: 'artifact', value: store.plan.artifactId });
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('refuses an acceptance time on a choice that accepts nothing', async () => {
  const store = await authorityStore();
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: {
        selection_id: uuidv7(),
        kind: 'final_recorded',
        target: store.target,
        scope: store.project,
        designation: null,
        authorization: null,
        expected_state: { kind: 'initial' },
      },
      selectedBy: AGENT,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'recorded_choices')).toBe(0);
});

it('replays the original result under the same operation id and refuses a changed field', async () => {
  const store = await authorityStore();
  const operationId = uuidv7();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  const input = { operationId, selection, selectedBy: OWNER, acceptedAt: AT, secretAllow: [] };
  const first = await publishProjectSelection(store.handle, input);
  const before = counters(store.handle);
  const replayed = await publishProjectSelection(store.handle, input);
  expect(replayed).toEqual({ ...first, replayed: true });
  expect(counters(store.handle)).toEqual(before);

  for (const changed of [
    { ...input, selection: { ...selection, designation: 'background' } },
    { ...input, acceptedAt: '2026-09-18T10:00:00.000Z' },
    { ...input, selectedBy: AGENT },
    { ...input, work: { work_context: ['cloud-only-report'] } },
  ])
    await expect(publishProjectSelection(store.handle, changed)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  expect(rowCount(store.handle, 'adoptions')).toBe(1);
});

it('refuses a target revision, an instruction source and an acknowledged rule it does not hold', async () => {
  const store = await authorityStore();
  const missing = { kind: 'requirement', entity_id: store.requirementId, revision_id: uuidv7() };
  for (const selection of [
    acceptedSelection(
      missing as ExpectationRevisionRef,
      store.project,
      instructedBy(store.instructionId, store.project)
    ),
    acceptedSelection(store.target, store.project, instructedBy(uuidv7(), store.project)),
    acceptedSelection(
      store.target,
      store.project,
      informedBy(store.instructionId, [missing as ExpectationRevisionRef], store.project)
    ),
  ])
    await expect(
      publishProjectSelection(store.handle, {
        operationId: uuidv7(),
        selection,
        selectedBy: OWNER,
        acceptedAt: AT,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('refuses a project id that is not this store’s and a branch as an authority scope', async () => {
  const store = await authorityStore();
  const foreign = { kind: 'project', project_id: uuidv7() };
  const branch = { kind: 'branch', branch: 'feature/retry' };
  for (const scope of [foreign, branch]) {
    const before = counters(store.handle);
    await expect(
      publishProjectSelection(store.handle, {
        operationId: uuidv7(),
        selection: acceptedSelection(
          store.target,
          scope as never,
          instructedBy(store.instructionId, scope as never)
        ),
        selectedBy: OWNER,
        acceptedAt: AT,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(counters(store.handle)).toEqual(before);
  }
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('refuses an acceptance with no authority and one whose instruction is scoped elsewhere', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(store.target, store.project, null);
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection,
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        store.target,
        store.project,
        instructedBy(store.instructionId, store.artifact)
      ),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('refuses a revoked authorization and one recorded for another adoption', async () => {
  const store = await authorityStore();
  const beside = await successor(store);
  const authorizationId = uuidv7();
  await publishProjectAuthorization(store.handle, {
    operationId: uuidv7(),
    authorization: {
      authorization_id: authorizationId,
      instruction: instructedBy(store.instructionId, store.project),
      adopts: [{ revision: store.target, designation: 'adopted' }],
      departs_from: [],
      restates: [],
      context: null,
      recorded_at: AT,
    },
    grantedBy: OWNER,
    secretAllow: [],
  });
  const reused = { kind: 'reused_authorization', authorization_id: authorizationId };
  // The authorization was recorded for the first revision, so it covers no other adoption.
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(beside, store.project, reused),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: {
      revocation_id: uuidv7(),
      revokes: { kind: 'authorization', id: authorizationId },
      scope: store.project,
      source_id: store.instructionId,
      instruction: instructedBy(store.instructionId, store.project),
      recorded_at: AT,
    },
    revokedBy: OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(store.target, store.project, reused),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('asks about a conflict instead of recording it, and accepts the adoption once acknowledged', async () => {
  const store = await authorityStore();
  const beside = await successor(store);
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
  const unacknowledged = acceptedSelection(
    beside,
    store.project,
    instructedBy(store.instructionId, store.project),
    { expectedState: observing([first.selection_id]) }
  );
  const before = counters(store.handle);
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: unacknowledged,
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'adoptions')).toBe(1);

  const acknowledged = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      beside,
      store.project,
      informedBy(store.instructionId, [store.target], store.project),
      { expectedState: observing([first.selection_id]) }
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(acknowledged.value.recordedIn).toBe('adoptions');
  expect(
    read(store.handle, (view) =>
      listProjectSelections(view, { kind: 'requirement', entityId: store.requirementId })
    )
  ).toHaveLength(2);
});

it('refuses an adoption identical to one that still stands and accepts one after a withdrawal', async () => {
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
  const before = counters(store.handle);
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        store.target,
        store.project,
        instructedBy(store.instructionId, store.project),
        { expectedState: observing([first.selection_id]) }
      ),
      selectedBy: OWNER,
      acceptedAt: '2026-09-18T10:00:00.000Z',
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(counters(store.handle)).toEqual(before);

  const withdrawn = await withdrawRevision(store.handle, {
    target: store.target,
    scope: store.project,
    sourceId: store.instructionId,
    instructionId: store.instructionId,
    expectedState: observing([first.selection_id]),
  });
  const again = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.project,
      instructedBy(store.instructionId, store.project),
      { expectedState: observing([], [withdrawn]) }
    ),
    selectedBy: OWNER,
    acceptedAt: '2026-09-19T10:00:00.000Z',
    secretAllow: [],
  });
  expect(again.value.recordedIn).toBe('adoptions');
  expect(rowCount(store.handle, 'adoptions')).toBe(2);
});

it('accepts a designation the same approver changes in the same scope', async () => {
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
  const redesignated = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.project,
      instructedBy(store.instructionId, store.project),
      { designation: 'background', expectedState: observing([first.selection_id]) }
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(
    read(store.handle, (view) => readProjectSelection(view, redesignated.value.selectionId))!
      .designation
  ).toBe('background');
});

it('fails a stale expected state atomically, with the state that governs now', async () => {
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
  const second = await openProjectDatabase({ authority: store.authority, mode: 'writer' });
  try {
    const before = counters(second);
    await expect(
      publishProjectSelection(second, {
        operationId: uuidv7(),
        selection: acceptedSelection(
          store.target,
          store.project,
          instructedBy(store.instructionId, store.project),
          { designation: 'background' }
        ),
        selectedBy: AGENT,
        acceptedAt: AT,
        secretAllow: [],
      })
    ).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
      current: { selection_ids: [first.selection_id], correction_action_ids: [] },
    });
    expect(counters(second)).toEqual(before);
    expect(rowCount(second, 'adoptions')).toBe(1);
  } finally {
    second.close();
  }
});

it('lets one of two processes adopt against the same observed state and refuses the other as stale', async () => {
  const store = await authorityStore();
  const candidate = fileURLToPath(new URL('../../../../../', import.meta.url));
  const script = path.join(candidate, 'packages/storage/tests/selection-race.mjs');
  const racers = [uuidv7(), uuidv7()].map(
    (selectionId) =>
      new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            script,
            candidate,
            JSON.stringify({
              authority: store.authority,
              operationId: uuidv7(),
              selection: acceptedSelection(
                store.target,
                store.project,
                instructedBy(store.instructionId, store.project),
                { selectionId }
              ),
              selectedBy: OWNER,
              acceptedAt: AT,
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
  expect(rowCount(store.handle, 'adoptions')).toBe(1);
});

it('refuses either designation of a revision an established replacement points at', async () => {
  const store = await authorityStore();
  const beside = await successor(store);
  await establishReplacement(store.handle, {
    from: beside,
    to: store.target,
    scope: store.project,
    sourceId: store.instructionId,
  });
  for (const designation of ['adopted', 'background'] as const) {
    const before = counters(store.handle);
    await expect(
      publishProjectSelection(store.handle, {
        operationId: uuidv7(),
        selection: acceptedSelection(
          store.target,
          store.project,
          instructedBy(store.instructionId, store.project),
          { designation }
        ),
        selectedBy: OWNER,
        acceptedAt: AT,
        secretAllow: [],
      }),
      designation
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(counters(store.handle)).toEqual(before);
  }
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('requires an artifact-scoped adoption to acknowledge the project rule it stands beside', async () => {
  const store = await authorityStore();
  const beside = await successor(store);
  const project = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: project,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const observed = observing([project.selection_id]);
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        beside,
        store.artifact,
        informedBy(store.instructionId, [beside], store.artifact),
        { expectedState: observed }
      ),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'adoptions')).toBe(1);

  const acknowledged = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      beside,
      store.artifact,
      informedBy(store.instructionId, [store.target], store.artifact),
      { expectedState: observed }
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(acknowledged.value.recordedIn).toBe('adoptions');
});

it('asks nothing of a project adoption about what one artifact adopted', async () => {
  const store = await authorityStore();
  const beside = await successor(store);
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.artifact,
      instructedBy(store.instructionId, store.artifact)
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  // An artifact's scope reaches nothing outside it, so the project act stands beside nothing.
  const published = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      beside,
      store.project,
      instructedBy(store.instructionId, store.project)
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(published.value.recordedIn).toBe('adoptions');
});
