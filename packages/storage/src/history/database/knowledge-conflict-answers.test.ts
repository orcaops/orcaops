import { afterEach, expect, it } from 'vitest';

import { publishProjectAuthorization } from './knowledge-authorizations.js';
import {
  listProjectConflictAnswers,
  publishProjectConflictAnswer,
  readProjectConflictAnswer,
} from './knowledge-conflict-answers.js';
import { AT, authorityStore, informedBy } from '../../../tests/knowledge-authority-store.js';
import {
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const CLOUD_STARTUP = {
  all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-startup'] }],
};

const answer = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  change: { id?: string; outcome?: 'authorized' | 'declined'; authorizationId?: string | null } = {}
) => ({
  answer_id: change.id ?? uuidv7(),
  rule: store.target,
  outcome: change.outcome ?? 'declined',
  context: CLOUD_STARTUP,
  scope: store.project,
  source_id: store.instructionId,
  answered_at: AT,
  authorization_id: change.authorizationId ?? null,
});

async function authorizationFor(store: Awaited<ReturnType<typeof authorityStore>>) {
  const authorizationId = uuidv7();
  await publishProjectAuthorization(store.handle, {
    operationId: uuidv7(),
    authorization: {
      authorization_id: authorizationId,
      instruction: informedBy(store.instructionId, [store.target], store.project),
      adopts: [],
      departs_from: [
        { rule: store.target, how: 'withdraws', exception_id: null, replaced_by: null },
      ],
      restates: [],
      context: CLOUD_STARTUP,
      recorded_at: AT,
    },
    grantedBy: OWNER,
    secretAllow: [],
  });
  return authorizationId;
}

it('keeps a refusal and its work, and moves no intent counter', async () => {
  const store = await authorityStore();
  const declined = answer(store);
  const before = counters(store.handle);
  const published = await publishProjectConflictAnswer(store.handle, {
    operationId: uuidv7(),
    answer: declined,
    answeredBy: OWNER,
    secretAllow: [],
  });
  expect(published.value.outcome).toBe('declined');
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const row = read(store.handle, (view) => readProjectConflictAnswer(view, declined.answer_id))!;
  const bytes = Buffer.from(row.recordHex, 'hex');
  expect(digest(bytes)).toBe(row.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...declined, answered_by: OWNER });
  expect(row).toMatchObject({
    rule: { kind: 'requirement', entityId: store.requirementId, revisionId: store.revisionId },
    outcome: 'declined',
    scope: { kind: 'project', value: null },
    answeredBy: { identity: OWNER.identity, basis: OWNER.basis },
    authorizationId: null,
  });
});

it('names the authorization an authorized answer produced', async () => {
  const store = await authorityStore();
  const authorizationId = await authorizationFor(store);
  const authorized = answer(store, { outcome: 'authorized', authorizationId });
  await publishProjectConflictAnswer(store.handle, {
    operationId: uuidv7(),
    answer: authorized,
    answeredBy: OWNER,
    secretAllow: [],
  });
  const [row] = read(store.handle, (view) =>
    listProjectConflictAnswers(view, { kind: 'requirement', entityId: store.requirementId })
  );
  expect(row).toMatchObject({ outcome: 'authorized', authorizationId });
});

it('refuses an authorized answer whose authorization is not retained, and a declined one that names any', async () => {
  const store = await authorityStore();
  await expect(
    publishProjectConflictAnswer(store.handle, {
      operationId: uuidv7(),
      answer: answer(store, { outcome: 'authorized', authorizationId: uuidv7() }),
      answeredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    publishProjectConflictAnswer(store.handle, {
      operationId: uuidv7(),
      answer: answer(store, { authorizationId: await authorizationFor(store) }),
      answeredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'conflict_answers')).toBe(0);
});

it('refuses a rule and a source this history does not hold, and a taken answer id', async () => {
  const store = await authorityStore();
  for (const record of [
    { ...answer(store), rule: { ...store.target, revision_id: uuidv7() } },
    { ...answer(store), source_id: uuidv7() },
  ])
    await expect(
      publishProjectConflictAnswer(store.handle, {
        operationId: uuidv7(),
        answer: record,
        answeredBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });

  const taken = answer(store);
  await publishProjectConflictAnswer(store.handle, {
    operationId: uuidv7(),
    answer: taken,
    answeredBy: OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectConflictAnswer(store.handle, {
      operationId: uuidv7(),
      answer: answer(store, { id: taken.answer_id }),
      answeredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'conflict_answers')).toBe(1);
});

it('replays the original result under the same operation id and refuses a changed answer', async () => {
  const store = await authorityStore();
  const operationId = uuidv7();
  const record = answer(store);
  const input = { operationId, answer: record, answeredBy: OWNER, secretAllow: [] };
  const first = await publishProjectConflictAnswer(store.handle, input);
  const before = counters(store.handle);
  expect(await publishProjectConflictAnswer(store.handle, input)).toEqual({
    ...first,
    replayed: true,
  });
  expect(counters(store.handle)).toEqual(before);
  await expect(
    publishProjectConflictAnswer(store.handle, {
      ...input,
      answer: { ...record, context: { all_of: [] } },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'conflict_answers')).toBe(1);
});

it('refuses a foreign project id and a branch as an authority scope', async () => {
  const store = await authorityStore();
  for (const scope of [
    { kind: 'project', project_id: uuidv7() },
    { kind: 'branch', branch: 'feature/retry' },
  ])
    await expect(
      publishProjectConflictAnswer(store.handle, {
        operationId: uuidv7(),
        answer: { ...answer(store), scope },
        answeredBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'conflict_answers')).toBe(0);
});
