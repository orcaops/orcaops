import { afterEach, expect, it } from 'vitest';

import { publishProjectAuthorization } from './knowledge-authorizations.js';
import {
  listProjectExceptions,
  publishProjectException,
  readProjectException,
} from './knowledge-exceptions.js';
import { publishProjectSelection } from './knowledge-selections.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  informedBy,
  instructedBy,
  observing,
} from '../../../tests/knowledge-authority-store.js';
import {
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { ExpectedState } from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const CLOUD_ONLY_REPORT = {
  all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-only-report'] }],
};
const WORK = { work_context: ['cloud-only-report'] };

const exception = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  change: {
    id?: string;
    ends?: unknown;
    endBehavior?: string;
    authorization?: unknown;
    expectedState?: ExpectedState;
    context?: unknown;
  } = {}
) => ({
  exception_id: change.id ?? uuidv7(),
  expectation: store.target,
  context: change.context ?? CLOUD_ONLY_REPORT,
  scope: store.project,
  rationale: 'The usage report is Cloud-only by nature; local capture is unaffected.',
  source_id: store.instructionId,
  authorization:
    change.authorization ?? informedBy(store.instructionId, [store.target], store.project),
  ends: change.ends ?? { kind: 'until_revoked' },
  end_behavior: change.endBehavior ?? 'expectation_applies_again',
  expected_state: change.expectedState ?? ({ kind: 'initial' } as ExpectedState),
});

it('records an exception with its end condition and end behaviour, and changes intent', async () => {
  const store = await authorityStore();
  const authored = exception(store);
  const before = counters(store.handle);
  const published = await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: authored,
    grantedBy: OWNER,
    work: WORK,
    secretAllow: [],
  });
  expect(published.value.exceptionId).toBe(authored.exception_id);
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  const row = read(store.handle, (view) => readProjectException(view, authored.exception_id))!;
  const bytes = Buffer.from(row.recordHex, 'hex');
  expect(digest(bytes)).toBe(row.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...authored, granted_by: OWNER });
  expect(row).toMatchObject({
    expectation: {
      kind: 'requirement',
      entityId: store.requirementId,
      revisionId: store.revisionId,
    },
    scope: { kind: 'project', value: null },
    grantedBy: { identity: OWNER.identity, basis: OWNER.basis },
    authorizationKind: 'informed_instruction',
    endKind: 'until_revoked',
    endBehavior: 'expectation_applies_again',
  });
});

it('records each way an exception can end', async () => {
  const store = await authorityStore();
  const ends = [
    {
      ends: { kind: 'until_time', until: '2026-12-01T00:00:00.000Z' },
      endBehavior: 'review_required',
    },
    {
      ends: { kind: 'until_condition', condition: 'The report runs offline.' },
      endBehavior: 'review_required',
    },
    { ends: { kind: 'until_revoked' }, endBehavior: 'expectation_applies_again' },
    { ends: { kind: 'unknown' }, endBehavior: 'none_recorded' },
  ];
  for (const end of ends)
    await publishProjectException(store.handle, {
      operationId: uuidv7(),
      exception: exception(store, end),
      grantedBy: OWNER,
      work: WORK,
      secretAllow: [],
    });
  expect(
    read(store.handle, (view) =>
      listProjectExceptions(view, { kind: 'requirement', entityId: store.requirementId })
    ).map((row) => [row.endKind, row.endBehavior])
  ).toEqual(ends.map((end) => [(end.ends as { kind: string }).kind, end.endBehavior]));
});

it('refuses an expiring exception with no end behaviour and one that applies everywhere with no known end', async () => {
  const store = await authorityStore();
  for (const change of [
    {
      ends: { kind: 'until_time', until: '2026-12-01T00:00:00.000Z' },
      endBehavior: 'none_recorded',
    },
    { context: { all_of: [] }, ends: { kind: 'unknown' } },
  ])
    await expect(
      publishProjectException(store.handle, {
        operationId: uuidv7(),
        exception: exception(store, change),
        grantedBy: OWNER,
        work: WORK,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(0);
});

it('refuses an instruction that acknowledges nothing or acknowledges an unrelated rule', async () => {
  const store = await authorityStore();
  for (const authorization of [
    instructedBy(store.instructionId, store.project),
    informedBy(
      store.instructionId,
      [{ kind: 'decision', entity_id: uuidv7(), revision_id: uuidv7() }],
      store.project
    ),
  ])
    await expect(
      publishProjectException(store.handle, {
        operationId: uuidv7(),
        exception: exception(store, { authorization }),
        grantedBy: OWNER,
        work: WORK,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(0);
});

it('reuses an earlier authorization for the same exception and refuses it for another', async () => {
  const store = await authorityStore();
  // An authorization stays valid while the rule it departs from stands, so the rule is adopted
  // first and every exception below observes that adoption.
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
  const adopted = observing([adoption.selection_id]);
  const exceptionId = uuidv7();
  const authorizationId = uuidv7();
  await publishProjectAuthorization(store.handle, {
    operationId: uuidv7(),
    authorization: {
      authorization_id: authorizationId,
      instruction: informedBy(store.instructionId, [store.target], store.project),
      adopts: [],
      departs_from: [
        { rule: store.target, how: 'excepts', exception_id: exceptionId, replaced_by: null },
      ],
      restates: [],
      context: CLOUD_ONLY_REPORT,
      recorded_at: AT,
    },
    grantedBy: OWNER,
    secretAllow: [],
  });
  const reused = { kind: 'reused_authorization', authorization_id: authorizationId };
  await expect(
    publishProjectException(store.handle, {
      operationId: uuidv7(),
      exception: exception(store, { authorization: reused, expectedState: adopted }),
      grantedBy: OWNER,
      work: WORK,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  // The same exception, for work the authorization's own context covers.
  const published = await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: exception(store, { id: exceptionId, authorization: reused, expectedState: adopted }),
    grantedBy: OWNER,
    work: WORK,
    secretAllow: [],
  });
  expect(published.value.exceptionId).toBe(exceptionId);
  // The work at hand decides: an authorization narrowed to other work is not reused.
  await expect(
    publishProjectException(store.handle, {
      operationId: uuidv7(),
      exception: exception(store, { authorization: reused, expectedState: adopted }),
      grantedBy: OWNER,
      work: { work_context: ['nightly-sync'] },
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(1);
});

it('fails a stale expected state atomically with the state that governs now', async () => {
  const store = await authorityStore();
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
  const before = counters(store.handle);
  await expect(
    publishProjectException(store.handle, {
      operationId: uuidv7(),
      exception: exception(store),
      grantedBy: OWNER,
      work: WORK,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
    current: { selection_ids: [adoption.selection_id], correction_action_ids: [] },
  });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(0);

  const published = await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: exception(store, { expectedState: observing([adoption.selection_id]) }),
    grantedBy: OWNER,
    work: WORK,
    secretAllow: [],
  });
  expect(published.value.expectationRevisionId).toBe(store.revisionId);
});

it('refuses an expectation and a source this history does not hold, and a taken exception id', async () => {
  const store = await authorityStore();
  const absent = { ...store.target, revision_id: uuidv7() };
  for (const change of [
    {
      expectation: absent,
      authorization: informedBy(store.instructionId, [absent], store.project),
    },
    { source_id: uuidv7() },
  ])
    await expect(
      publishProjectException(store.handle, {
        operationId: uuidv7(),
        exception: { ...exception(store), ...change },
        grantedBy: OWNER,
        work: WORK,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });

  const taken = exception(store);
  await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: taken,
    grantedBy: OWNER,
    work: WORK,
    secretAllow: [],
  });
  await expect(
    publishProjectException(store.handle, {
      operationId: uuidv7(),
      exception: exception(store, { id: taken.exception_id }),
      grantedBy: OWNER,
      work: WORK,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(1);
});

it('replays the original result under the same operation id and refuses changed work', async () => {
  const store = await authorityStore();
  const operationId = uuidv7();
  const input = {
    operationId,
    exception: exception(store),
    grantedBy: OWNER,
    work: WORK,
    secretAllow: [],
  };
  const first = await publishProjectException(store.handle, input);
  const before = counters(store.handle);
  expect(await publishProjectException(store.handle, input)).toEqual({ ...first, replayed: true });
  expect(counters(store.handle)).toEqual(before);
  await expect(
    publishProjectException(store.handle, { ...input, work: { work_context: ['nightly-sync'] } })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(1);
});

it('refuses a foreign project id and a branch as an authority scope', async () => {
  const store = await authorityStore();
  for (const scope of [
    { kind: 'project', project_id: uuidv7() },
    { kind: 'branch', branch: 'feature/retry' },
  ])
    await expect(
      publishProjectException(store.handle, {
        operationId: uuidv7(),
        exception: {
          ...exception(store),
          scope,
          authorization: informedBy(store.instructionId, [store.target], scope as never),
        },
        grantedBy: OWNER,
        work: WORK,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'knowledge_exceptions')).toBe(0);
});
