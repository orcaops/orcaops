import { afterEach, expect, it } from 'vitest';

import {
  publishProjectAuthorization,
  readProjectAuthorization,
} from './knowledge-authorizations.js';
import {
  AT,
  authorityStore,
  informedBy,
  instructedBy,
} from '../../../tests/knowledge-authority-store.js';
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

const authorization = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  change: { id?: string; instruction?: unknown; departs?: unknown[]; context?: unknown } = {}
) => ({
  authorization_id: change.id ?? uuidv7(),
  instruction: change.instruction ?? informedBy(store.instructionId, [store.target], store.project),
  adopts: [],
  departs_from: change.departs ?? [
    { rule: store.target, how: 'excepts', exception_id: 'exception-0', replaced_by: null },
  ],
  restates: [],
  context: change.context ?? {
    all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-only-report'] }],
  },
  recorded_at: AT,
});

it('retains the instruction with exactly the footprint it authorized, and moves no intent counter', async () => {
  const store = await authorityStore();
  const record = authorization(store);
  const before = counters(store.handle);
  const published = await publishProjectAuthorization(store.handle, {
    operationId: uuidv7(),
    authorization: record,
    grantedBy: OWNER,
    secretAllow: [],
  });
  expect(published.value.authorizationId).toBe(record.authorization_id);
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const row = read(store.handle, (view) =>
    readProjectAuthorization(view, record.authorization_id)
  )!;
  const bytes = Buffer.from(row.recordHex, 'hex');
  expect(digest(bytes)).toBe(row.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...record, granted_by: OWNER });
  expect(row).toMatchObject({
    instruction: { kind: 'informed_instruction', sourceId: store.instructionId },
    scope: { kind: 'project', value: null },
    grantedBy: { identity: OWNER.identity, basis: OWNER.basis },
  });
});

it('replays the original result under the same operation id and refuses a changed footprint', async () => {
  const store = await authorityStore();
  const operationId = uuidv7();
  const record = authorization(store);
  const input = { operationId, authorization: record, grantedBy: OWNER, secretAllow: [] };
  const first = await publishProjectAuthorization(store.handle, input);
  const before = counters(store.handle);
  expect(await publishProjectAuthorization(store.handle, input)).toEqual({
    ...first,
    replayed: true,
  });
  expect(counters(store.handle)).toEqual(before);
  await expect(
    publishProjectAuthorization(store.handle, {
      ...input,
      authorization: { ...record, context: null },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'knowledge_authorizations')).toBe(1);
});

it('refuses an instruction source, an acknowledged rule and a footprint revision it does not hold', async () => {
  const store = await authorityStore();
  const absent = {
    kind: 'requirement' as const,
    entity_id: store.requirementId,
    revision_id: uuidv7(),
  };
  for (const record of [
    authorization(store, { instruction: informedBy(uuidv7(), [store.target], store.project) }),
    authorization(store, {
      instruction: informedBy(store.instructionId, [absent, store.target], store.project),
    }),
    authorization(store, {
      instruction: informedBy(store.instructionId, [absent, store.target], store.project),
      departs: [{ rule: absent, how: 'withdraws', exception_id: null, replaced_by: null }],
    }),
  ])
    await expect(
      publishProjectAuthorization(store.handle, {
        operationId: uuidv7(),
        authorization: record,
        grantedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(store.handle, 'knowledge_authorizations')).toBe(0);
});

it('refuses one that authorizes nothing, one outside this project, and a taken id', async () => {
  const store = await authorityStore();
  for (const record of [
    authorization(store, { departs: [] }),
    authorization(store, {
      instruction: instructedBy(store.instructionId, {
        kind: 'project',
        project_id: uuidv7(),
      } as never),
      departs: [],
    }),
  ])
    await expect(
      publishProjectAuthorization(store.handle, {
        operationId: uuidv7(),
        authorization: record,
        grantedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  const taken = authorization(store);
  await publishProjectAuthorization(store.handle, {
    operationId: uuidv7(),
    authorization: taken,
    grantedBy: OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectAuthorization(store.handle, {
      operationId: uuidv7(),
      authorization: authorization(store, { id: taken.authorization_id }),
      grantedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'knowledge_authorizations')).toBe(1);
});

it('refuses an acting actor named inside the record', async () => {
  const store = await authorityStore();
  await expect(
    publishProjectAuthorization(store.handle, {
      operationId: uuidv7(),
      authorization: { ...authorization(store), granted_by: OWNER },
      grantedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
