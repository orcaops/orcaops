import { afterEach, expect, it } from 'vitest';

import {
  publishProjectSubject,
  publishProjectSubjectRevision,
  readProjectSubject,
} from './knowledge-subjects.js';
import {
  AGENT,
  captureFieldSource,
  counters,
  discardKnowledgeStores,
  OWNER,
  plannedKnowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-17T11:00:00.000Z';

async function store() {
  const { handle, plan } = await plannedKnowledgeStore();
  const sourceId = await captureFieldSource(handle, plan);
  return { handle, plan, sourceId };
}

const subjectRevision = (
  subjectId: string,
  sourceId: string,
  previous: string | null = null,
  label = 'Local capture'
) => ({
  subject_id: subjectId,
  revision_id: uuidv7(),
  previous_revision_id: previous,
  label,
  kind: 'capability' as const,
  description: 'Recording a plan, checkpoint or summary on this machine.',
  source_ids: [sourceId],
  recorded_at: AT,
});

const subject = (handle: Parameters<typeof rowCount>[0], subjectId: string) =>
  read(handle, (view) => readProjectSubject(view, subjectId));

it('publishes a subject with its first revision and moves no intent counter', async () => {
  const { handle, sourceId } = await store();
  const revision = subjectRevision(uuidv7(), sourceId);
  const before = counters(handle);
  const published = await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision,
    authoredBy: OWNER,
    secretAllow: [],
  });
  expect(published.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  const retained = subject(handle, revision.subject_id)!;
  expect(retained.firstRevisionId).toBe(revision.revision_id);
  const bytes = Buffer.from(retained.revisions[0]!.recordHex, 'hex');
  expect(digest(bytes)).toBe(retained.revisions[0]!.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({ ...revision, authored_by: OWNER });
  expect(retained.revisions[0]!.authoredByBasis).toBe(OWNER.basis);
});

it('publishes a further revision without moving the intent counter', async () => {
  const { handle, sourceId } = await store();
  const first = subjectRevision(uuidv7(), sourceId);
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: first,
    authoredBy: OWNER,
    secretAllow: [],
  });
  const before = counters(handle);
  const next = await publishProjectSubjectRevision(handle, {
    operationId: uuidv7(),
    revision: subjectRevision(first.subject_id, sourceId, first.revision_id, 'Capture, offline'),
    authoredBy: OWNER,
    secretAllow: [],
  });
  expect(next.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
});

it('keeps two sibling revisions of one predecessor and refuses a second first revision', async () => {
  const { handle, sourceId } = await store();
  const first = subjectRevision(uuidv7(), sourceId);
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: first,
    authoredBy: OWNER,
    secretAllow: [],
  });
  const tighter = subjectRevision(
    first.subject_id,
    sourceId,
    first.revision_id,
    'Capture, offline'
  );
  const looser = subjectRevision(first.subject_id, sourceId, first.revision_id, 'Capture');
  await publishProjectSubjectRevision(handle, {
    operationId: uuidv7(),
    revision: tighter,
    authoredBy: OWNER,
    secretAllow: [],
  });
  await publishProjectSubjectRevision(handle, {
    operationId: uuidv7(),
    revision: looser,
    authoredBy: AGENT,
    secretAllow: [],
  });
  expect(subject(handle, first.subject_id)!.revisions.map((row) => row.revisionId)).toEqual([
    first.revision_id,
    tighter.revision_id,
    looser.revision_id,
  ]);

  const before = rowCount(handle, 'subject_revisions');
  await expect(
    publishProjectSubjectRevision(handle, {
      operationId: uuidv7(),
      revision: subjectRevision(first.subject_id, sourceId),
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectSubject(handle, {
      operationId: uuidv7(),
      revision: subjectRevision(first.subject_id, sourceId),
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'subject_revisions')).toBe(before);
});

it('refuses a revision that continues another subject and one that reuses a revision id', async () => {
  const { handle, sourceId } = await store();
  const mine = subjectRevision(uuidv7(), sourceId);
  const theirs = subjectRevision(uuidv7(), sourceId);
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: mine,
    authoredBy: OWNER,
    secretAllow: [],
  });
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: theirs,
    authoredBy: OWNER,
    secretAllow: [],
  });
  const before = rowCount(handle, 'subject_revisions');
  await expect(
    publishProjectSubjectRevision(handle, {
      operationId: uuidv7(),
      revision: subjectRevision(mine.subject_id, sourceId, theirs.revision_id),
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishProjectSubjectRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...subjectRevision(mine.subject_id, sourceId, mine.revision_id),
        revision_id: theirs.revision_id,
      },
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'subject_revisions')).toBe(before);
});

it('refuses a subject this history does not hold and a source it does not hold', async () => {
  const { handle, sourceId } = await store();
  await expect(
    publishProjectSubjectRevision(handle, {
      operationId: uuidv7(),
      revision: subjectRevision(uuidv7(), sourceId, uuidv7()),
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    publishProjectSubject(handle, {
      operationId: uuidv7(),
      revision: subjectRevision(uuidv7(), uuidv7()),
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'subjects')).toBe(0);
  expect(rowCount(handle, 'subject_revisions')).toBe(0);
});

it('replays the original result and refuses a changed authored field under one operation id', async () => {
  const { handle, sourceId } = await store();
  const operationId = uuidv7();
  const revision = subjectRevision(uuidv7(), sourceId);
  const first = await publishProjectSubject(handle, {
    operationId,
    revision,
    authoredBy: OWNER,
    secretAllow: [],
  });
  await publishProjectSubject(handle, {
    operationId: uuidv7(),
    revision: subjectRevision(uuidv7(), sourceId),
    authoredBy: OWNER,
    secretAllow: [],
  });
  expect(
    await publishProjectSubject(handle, {
      operationId,
      revision,
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).toEqual({ ...first, replayed: true });
  const before = rowCount(handle, 'subject_revisions');
  await expect(
    publishProjectSubject(handle, {
      operationId,
      revision: { ...revision, description: 'Something else' },
      authoredBy: OWNER,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    publishProjectSubject(handle, {
      operationId,
      revision,
      authoredBy: AGENT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'subject_revisions')).toBe(before);
});

it('refuses a named actor on an unknown basis', async () => {
  const { handle, sourceId } = await store();
  await expect(
    publishProjectSubject(handle, {
      operationId: uuidv7(),
      revision: subjectRevision(uuidv7(), sourceId),
      authoredBy: { identity: 'owner@example.test', basis: 'unknown' },
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'subjects')).toBe(0);
});
