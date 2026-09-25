import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';

import { openProjectDatabase } from './connection.js';
import { publishProjectAuthorization } from './knowledge-authorizations.js';
import { publishProjectConflictAnswer } from './knowledge-conflict-answers.js';
import { publishProjectException } from './knowledge-exceptions.js';
import {
  listProjectRevocations,
  publishProjectRevocation,
  publishProjectRevocationWithSource,
} from './knowledge-revocations.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { resolveProjectKnowledge } from './knowledge-standing.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  informedBy,
  instructedBy,
  observing,
  revokeDirectly,
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
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const CLOUD_ONLY_REPORT = {
  all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-only-report'] }],
};

const revocation = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  revokes: { kind: string; id: string },
  change: { id?: string; scope?: unknown } = {}
) => ({
  revocation_id: change.id ?? uuidv7(),
  revokes,
  scope: change.scope ?? store.project,
  source_id: store.instructionId,
  instruction: instructedBy(store.instructionId, (change.scope ?? store.project) as never),
  recorded_at: AT,
});

const revocationWithSource = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  revokes: { kind: 'authorization'; id: string },
  reason: string
) => {
  const bytes = Buffer.from(reason);
  const sourceId = uuidv7();
  return {
    operationId: uuidv7(),
    source: {
      source: {
        source_id: sourceId,
        occurrence: {
          kind: 'user_instruction',
          retention: {
            kind: 'bytes',
            content_sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          location: 'test revocation',
          source_time: AT,
        },
        source_author: OWNER,
        interpreted_by: null,
        access_restriction: null,
      },
      recordedBy: OWNER,
      retainedBytes: bytes,
      secretAllow: [],
    },
    revocation: {
      revocation_id: uuidv7(),
      revokes,
      scope: store.project,
      source_id: sourceId,
      instruction: instructedBy(sourceId, store.project),
      recorded_at: AT,
    },
    revokedBy: OWNER,
    secretAllow: [],
  };
};

/** An adoption resting on an authorization recorded for exactly that adoption. */
async function adoptedUnderAuthorization(store: Awaited<ReturnType<typeof authorityStore>>) {
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
  const selection = acceptedSelection(store.target, store.project, {
    kind: 'reused_authorization',
    authorization_id: authorizationId,
  });
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  return { authorizationId, selectionId: selection.selection_id };
}

it('ends an authorization without undoing the adoption made under it', async () => {
  const store = await authorityStore();
  const { authorizationId, selectionId } = await adoptedUnderAuthorization(store);
  const ending = revocation(store, { kind: 'authorization', id: authorizationId });
  const before = counters(store.handle);
  const published = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: ending,
    revokedBy: OWNER,
    secretAllow: [],
  });
  expect(published.value.revokes).toEqual({ kind: 'authorization', id: authorizationId });
  // Ending an authorization ends evidence; what was done under it still stands.
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const resolved = read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      store.project,
      {}
    )
  );
  const entry = resolved.revisions.find((row) => row.revision.revision_id === store.revisionId)!;
  expect(entry.standing).toBe('stands');
  expect(entry.stood_by).toEqual([selectionId]);
  expect(entry.authority_revoked_by).toEqual([
    { selection_id: selectionId, revocation_ids: [ending.revocation_id] },
  ]);
  expect(resolved.governing_state.selection_ids).toEqual([selectionId]);
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        store.target,
        store.project,
        { kind: 'reused_authorization', authorization_id: authorizationId },
        { expectedState: observing([selectionId], []) }
      ),
      selectedBy: AGENT,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'adoptions')).toBe(1);

  const [row] = read(store.handle, (view) =>
    listProjectRevocations(view, { kind: 'authorization', id: authorizationId })
  );
  const bytes = Buffer.from(row!.recordHex, 'hex');
  expect(digest(bytes)).toBe(row!.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...ending, revoked_by: OWNER });
  expect(row).toMatchObject({
    scope: { kind: 'project', value: null },
    revokedBy: { identity: OWNER.identity, basis: OWNER.basis },
    instructionKind: 'explicit_instruction',
  });
});

it('settles only the winning reason source when revocations race', async () => {
  const store = await authorityStore();
  const { authorizationId } = await adoptedUnderAuthorization(store);
  const other = await openProjectDatabase({ authority: store.authority, mode: 'writer' });
  const beforeSources = rowCount(store.handle, 'knowledge_sources');
  const beforeCounters = counters(store.handle);
  const firstInput = revocationWithSource(
    store,
    { kind: 'authorization', id: authorizationId },
    'The first reason.'
  );
  const competingInput = revocationWithSource(
    store,
    { kind: 'authorization', id: authorizationId },
    'The competing reason.'
  );
  try {
    const outcomes = await Promise.allSettled([
      publishProjectRevocationWithSource(store.handle, firstInput),
      publishProjectRevocationWithSource(other, competingInput),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(rowCount(store.handle, 'knowledge_revocations')).toBe(1);
    expect(rowCount(store.handle, 'knowledge_sources')).toBe(beforeSources + 1);
    expect(counters(store.handle)).toEqual({
      writeSequence: beforeCounters.writeSequence + 1,
      intentChangeCounter: beforeCounters.intentChangeCounter,
    });
    const retainedSourceIds = read(store.handle, (view) =>
      view
        .all<{
          source_id: string;
        }>(
          'SELECT source_id FROM knowledge_sources WHERE source_id IN (?, ?) ORDER BY source_id',
          firstInput.source.source.source_id,
          competingInput.source.source.source_id
        )
        .map(({ source_id }) => source_id)
    );
    const winningIndex = outcomes.findIndex((outcome) => outcome.status === 'fulfilled');
    expect(retainedSourceIds).toEqual([
      [firstInput, competingInput][winningIndex]!.source.source.source_id,
    ]);
  } finally {
    other.close();
  }
});

it('binds a compound revocation replay to its retained reason bytes', async () => {
  const store = await authorityStore();
  const { authorizationId } = await adoptedUnderAuthorization(store);
  const input = revocationWithSource(
    store,
    { kind: 'authorization', id: authorizationId },
    'The retained reason.'
  );
  const first = await publishProjectRevocationWithSource(store.handle, input);
  const before = counters(store.handle);
  const beforeSources = rowCount(store.handle, 'knowledge_sources');

  expect(await publishProjectRevocationWithSource(store.handle, input)).toEqual({
    ...first,
    replayed: true,
  });

  const changedBytes = Buffer.from('A different retained reason.');
  await expect(
    publishProjectRevocationWithSource(store.handle, {
      ...input,
      source: {
        ...input.source,
        source: {
          ...input.source.source,
          occurrence: {
            ...input.source.source.occurrence,
            retention: {
              kind: 'bytes',
              content_sha256: createHash('sha256').update(changedBytes).digest('hex'),
            },
          },
        },
        retainedBytes: changedBytes,
      },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'knowledge_sources')).toBe(beforeSources);
  expect(rowCount(store.handle, 'knowledge_revocations')).toBe(1);
});

it('stops a later act from reusing the authorization it ended', async () => {
  const store = await authorityStore();
  const { authorizationId, selectionId } = await adoptedUnderAuthorization(store);
  await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: revocation(store, { kind: 'authorization', id: authorizationId }),
    revokedBy: OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(
        store.target,
        store.project,
        { kind: 'reused_authorization', authorization_id: authorizationId },
        { designation: 'background', expectedState: observing([selectionId]) }
      ),
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'adoptions')).toBe(1);
});

it('ends an exception as a change of intent and an answer as none', async () => {
  const store = await authorityStore();
  const exceptionId = uuidv7();
  await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: store.target,
      context: CLOUD_ONLY_REPORT,
      scope: store.project,
      rationale: 'The usage report is Cloud-only by nature.',
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: { kind: 'initial' },
    },
    grantedBy: OWNER,
    work: { work_context: ['cloud-only-report'] },
    secretAllow: [],
  });
  const answerId = uuidv7();
  await publishProjectConflictAnswer(store.handle, {
    operationId: uuidv7(),
    answer: {
      answer_id: answerId,
      rule: store.target,
      outcome: 'declined',
      context: CLOUD_ONLY_REPORT,
      scope: store.project,
      source_id: store.instructionId,
      answered_at: AT,
      authorization_id: null,
    },
    answeredBy: OWNER,
    secretAllow: [],
  });

  const beforeException = counters(store.handle);
  const endedException = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: revocation(store, { kind: 'exception', id: exceptionId }),
    revokedBy: OWNER,
    secretAllow: [],
  });
  expect(endedException.counters.intentChangeCounter).toBe(beforeException.intentChangeCounter + 1);

  const beforeAnswer = counters(store.handle);
  const endedAnswer = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: revocation(store, { kind: 'conflict_answer', id: answerId }),
    revokedBy: OWNER,
    secretAllow: [],
  });
  expect(endedAnswer.counters).toEqual({
    writeSequence: beforeAnswer.writeSequence + 1,
    intentChangeCounter: beforeAnswer.intentChangeCounter,
  });
  const resolved = read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: 'requirement', entity_id: store.requirementId },
      store.authority.projectId,
      store.project,
      { work_context: ['cloud-only-report'] }
    )
  );
  expect(resolved.exceptions).toEqual([
    expect.objectContaining({ exception_id: exceptionId, standing: 'ended' }),
  ]);
});

/** An exception of the store's own target, in whatever scope the caller asks for. */
async function exceptionIn(
  store: Awaited<ReturnType<typeof authorityStore>>,
  scope: typeof store.project
): Promise<string> {
  const exceptionId = uuidv7();
  await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: store.target,
      context: CLOUD_ONLY_REPORT,
      scope,
      rationale: 'The usage report is Cloud-only by nature.',
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [store.target], scope),
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: { kind: 'initial' },
    },
    grantedBy: OWNER,
    work: { work_context: ['cloud-only-report'] },
    secretAllow: [],
  });
  return exceptionId;
}

it('ends an exception once, whatever a second act says', async () => {
  const store = await authorityStore();
  const exceptionId = uuidv7();
  const otherId = await exceptionIn(store, store.project);
  await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: store.target,
      context: CLOUD_ONLY_REPORT,
      scope: store.project,
      rationale: 'The usage report is Cloud-only by nature.',
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: { kind: 'initial' },
    },
    grantedBy: OWNER,
    work: { work_context: ['cloud-only-report'] },
    secretAllow: [],
  });
  const first = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: revocation(store, { kind: 'exception', id: exceptionId }),
    revokedBy: OWNER,
    secretAllow: [],
  });

  const ended = counters(store.handle);
  for (const _ of [1, 2])
    await expect(
      publishProjectRevocation(store.handle, {
        operationId: uuidv7(),
        revocation: revocation(store, { kind: 'exception', id: exceptionId }),
        revokedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      message: `That exception is already ended by revocation ${first.value.revocationId}`,
    });
  expect(rowCount(store.handle, 'knowledge_revocations')).toBe(1);
  expect(counters(store.handle)).toEqual(ended);

  // Another exception is a record of its own, and ending it is a change of intent of its own.
  const other = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: revocation(store, { kind: 'exception', id: otherId }),
    revokedBy: OWNER,
    secretAllow: [],
  });
  expect(other.counters.intentChangeCounter).toBe(ended.intentChangeCounter + 1);
});

it('refuses a narrower revocation of a record a standing wider one already ends', async () => {
  const store = await authorityStore();
  const exceptionId = await exceptionIn(store, store.artifact);
  const wider = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: revocation(store, { kind: 'exception', id: exceptionId }),
    revokedBy: OWNER,
    secretAllow: [],
  });
  const ended = counters(store.handle);
  await expect(
    publishProjectRevocation(store.handle, {
      operationId: uuidv7(),
      revocation: revocation(
        store,
        { kind: 'exception', id: exceptionId },
        { scope: store.artifact }
      ),
      revokedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
    message: `That exception is already ended by revocation ${wider.value.revocationId}`,
  });
  expect(rowCount(store.handle, 'knowledge_revocations')).toBe(1);
  expect(counters(store.handle)).toEqual(ended);
});

it('refuses a record it does not hold, a source it does not hold and a taken revocation id', async () => {
  const store = await authorityStore();
  const { authorizationId } = await adoptedUnderAuthorization(store);
  for (const record of [
    revocation(store, { kind: 'exception', id: uuidv7() }),
    { ...revocation(store, { kind: 'authorization', id: authorizationId }), source_id: uuidv7() },
  ])
    await expect(
      publishProjectRevocation(store.handle, {
        operationId: uuidv7(),
        revocation: record,
        revokedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });

  const taken = revocation(store, { kind: 'authorization', id: authorizationId });
  await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: taken,
    revokedBy: OWNER,
    secretAllow: [],
  });
  await expect(
    publishProjectRevocation(store.handle, {
      operationId: uuidv7(),
      revocation: revocation(
        store,
        { kind: 'authorization', id: authorizationId },
        { id: taken.revocation_id }
      ),
      revokedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'knowledge_revocations')).toBe(1);
});

it('refuses an instruction from another scope, a foreign project id and a branch scope', async () => {
  const store = await authorityStore();
  const { authorizationId } = await adoptedUnderAuthorization(store);
  const revokes = { kind: 'authorization', id: authorizationId };
  for (const record of [
    {
      ...revocation(store, revokes),
      instruction: instructedBy(store.instructionId, store.artifact),
    },
    revocation(store, revokes, { scope: { kind: 'project', project_id: uuidv7() } }),
    revocation(store, revokes, { scope: { kind: 'branch', branch: 'feature/retry' } }),
  ])
    await expect(
      publishProjectRevocation(store.handle, {
        operationId: uuidv7(),
        revocation: record,
        revokedBy: OWNER,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'knowledge_revocations')).toBe(0);
});

it('replays the original result under the same operation id and refuses a changed revocation', async () => {
  const store = await authorityStore();
  const { authorizationId } = await adoptedUnderAuthorization(store);
  const operationId = uuidv7();
  const record = revocation(store, { kind: 'authorization', id: authorizationId });
  const input = { operationId, revocation: record, revokedBy: OWNER, secretAllow: [] };
  const first = await publishProjectRevocation(store.handle, input);
  const before = counters(store.handle);
  expect(await publishProjectRevocation(store.handle, input)).toEqual({ ...first, replayed: true });
  expect(counters(store.handle)).toEqual(before);
  await expect(
    publishProjectRevocation(store.handle, {
      ...input,
      revocation: { ...record, recorded_at: '2026-10-01T10:00:00.000Z' },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'knowledge_revocations')).toBe(1);
});

it('refuses a revocation that acts in a narrower scope than the record it ends', async () => {
  const store = await authorityStore();
  const { authorizationId, selectionId } = await adoptedUnderAuthorization(store);
  const before = counters(store.handle);
  await expect(
    publishProjectRevocation(store.handle, {
      operationId: uuidv7(),
      revocation: revocation(
        store,
        { kind: 'authorization', id: authorizationId },
        { scope: store.artifact }
      ),
      revokedBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'knowledge_revocations')).toBe(0);
  expect(counters(store.handle)).toEqual(before);

  // The project-scoped authorization is untouched, so a second approver may still reuse it.
  const again = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.project,
      { kind: 'reused_authorization', authorization_id: authorizationId },
      { expectedState: observing([selectionId]) }
    ),
    selectedBy: AGENT,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(again.value.recordedIn).toBe('adoptions');
});

it('lets a revocation of a record in its own scope, and a wider one, end it', async () => {
  const store = await authorityStore();
  const exceptionId = uuidv7();
  await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: store.target,
      context: CLOUD_ONLY_REPORT,
      scope: store.artifact,
      rationale: 'The usage report is Cloud-only by nature.',
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [store.target], store.artifact),
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: { kind: 'initial' },
    },
    grantedBy: OWNER,
    work: { work_context: ['cloud-only-report'] },
    secretAllow: [],
  });
  const ended = await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: revocation(store, { kind: 'exception', id: exceptionId }),
    revokedBy: OWNER,
    secretAllow: [],
  });
  expect(ended.value.revokes).toEqual({ kind: 'exception', id: exceptionId });
});

it('leaves a wider act to a wider revocation when a narrow one is already stored', async () => {
  const store = await authorityStore();
  const { authorizationId, selectionId } = await adoptedUnderAuthorization(store);
  // A row this store received rather than wrote: narrower than what it names.
  await revokeDirectly(store.handle, {
    revokes: { kind: 'authorization', id: authorizationId },
    scope: store.artifact,
    sourceId: store.instructionId,
  });
  const reused = { kind: 'reused_authorization', authorization_id: authorizationId };
  const project = await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(store.target, store.project, reused, {
      expectedState: observing([selectionId]),
    }),
    selectedBy: AGENT,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(project.value.recordedIn).toBe('adoptions');

  await revokeDirectly(store.handle, {
    revokes: { kind: 'authorization', id: authorizationId },
    scope: store.project,
    sourceId: store.instructionId,
  });
  await expect(
    publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection: acceptedSelection(store.target, store.project, reused, {
        expectedState: observing([selectionId, project.value.selectionId]),
      }),
      selectedBy: OWNER,
      acceptedAt: '2026-09-19T10:00:00.000Z',
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
