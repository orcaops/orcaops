// Receipt-first replay on the switched public review verbs. Every case here
// asks the same two questions of one verb: an invocation interrupted after it
// settled, retried under its original operation identity, replays without
// writing a second row; and the same identity carrying different authored input
// refuses instead of settling that input under the first one's identity.

import { afterAll, beforeAll, expect, it } from 'vitest';

import { lineHash } from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';

import { applyDatabaseReviewComments } from './comment-command.js';
import { executeDatabaseReviewData } from './floor-command.js';
import { readDatabaseReviewFloor } from './floors.js';
import { readDatabaseReviewPane, readDatabaseReviewPaneGenerations } from './pane.js';
import { deriveReviewOperationId } from './review-operation.js';
import {
  finalizeCanonicalRun,
  recordCanonicalLaneServed,
  startCanonicalRun,
  submitCanonicalLane,
} from './run-command.js';
import { applyDatabaseReviewWorkflow } from './workflow-command.js';
import {
  capturedReviewFixture,
  type CapturedReviewFixture,
} from '../../tests/capturedReviewFixture.js';
import { parsePatchHunks } from '../patchHunks.js';

const FORENSIC = JSON.stringify({
  findings: [
    {
      claim: 'The limiter has no shared clock across processes.',
      file: 'src/limiter.ts',
      related_files: [],
      severity: 'CAUTION',
      confidence: 'HIGH',
    },
  ],
  questions: [],
});

const EXECUTION_PROFILE = {
  host: null,
  host_version: null,
  model: null,
  effort: null,
  launcher_mode: null,
  instruction_hash: null,
};

let fixture: CapturedReviewFixture;

beforeAll(async () => {
  fixture = await capturedReviewFixture({ autoCleanup: false });
}, 300_000);

afterAll(async () => {
  await fixture.cleanup();
});

const locator = () => ({
  branch: fixture.branch,
  root: fixture.gitRoot,
  dataRoot: fixture.dataRoot,
  projectId: fixture.projectId,
});

/** Every retained operation identity, in commit order. */
async function receipts(): Promise<{ operation_id: string; operation_kind: string }[]> {
  return fixture.read(
    (database) =>
      database.read((view) =>
        view.all<{ operation_id: string; operation_kind: string }>(
          'SELECT operation_id, operation_kind FROM operations ORDER BY committed_write_sequence'
        )
      ).value
  );
}

const kinds = async (kind: string) =>
  (await receipts()).filter((row) => row.operation_kind === kind);

/** Every retained comment revision, so a replay can be shown to add none. */
async function commentRevisionRows(): Promise<{ comment_id: string; version: number }[]> {
  return fixture.read(
    (database) =>
      database.read((view) =>
        view.all<{ comment_id: string; version: number }>(
          'SELECT comment_id, version FROM review_comment_revisions ORDER BY comment_id, version'
        )
      ).value
  );
}

const CONFLICT = { code: 'IDEMPOTENCY_CONFLICT' };

it('replays a published floor under its original identity and refuses a different base', async () => {
  const operationId = uuidv7();
  const published = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId,
    generatedAt: '2026-06-11T00:00:00.000Z',
    secretAllow: [],
  });
  expect(published.floor_outcome).toBe('published');
  expect(published.replayed).toBe(false);
  const after = await kinds('review.floor');

  const replayed = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId,
    generatedAt: '2026-06-11T09:99:99.000Z'.replace('99:99', '30:00'),
    secretAllow: [],
  });
  expect(replayed.replayed).toBe(true);
  expect(replayed.publication_id).toBe(published.publication_id);
  expect(replayed.review_id).toBe(published.review_id);
  expect(replayed.floor.input_hash).toBe(published.floor.input_hash);
  expect(await kinds('review.floor')).toEqual(after);

  // The review resolution settles under a derived child of the same identity,
  // so one --operation-id addresses both halves of the verb.
  const resolution = deriveReviewOperationId(operationId, 'review.resolution');
  expect((await receipts()).map((row) => row.operation_id)).toContain(resolution);

  await expect(
    executeDatabaseReviewData({
      branch: fixture.branch,
      root: fixture.gitRoot,
      dataRoot: fixture.dataRoot,
      projectId: fixture.projectId,
      operationId,
      base: 'HEAD~1',
      generatedAt: '2026-06-11T00:01:00.000Z',
      secretAllow: [],
    })
  ).rejects.toMatchObject(CONFLICT);
  expect(await kinds('review.floor')).toEqual(after);
}, 300_000);

it('replays a minted run under its original identity and refuses a different branch', async () => {
  const operationId = uuidv7();
  const start = {
    ...locator(),
    profile: 'routine' as const,
    createdAt: '2026-06-11T00:02:00.000Z',
    runtimeIdentity: null,
    executionProfile: EXECUTION_PROFILE,
    operationId,
    secretAllow: [],
  };
  const started = await startCanonicalRun(start);
  expect(started.replayed).toBe(false);
  const after = await kinds('review.run.start');

  const replayed = await startCanonicalRun({ ...start, createdAt: '2026-06-11T00:03:00.000Z' });
  expect(replayed.replayed).toBe(true);
  expect(replayed.runId).toBe(started.runId);
  expect(replayed.revisionId).toBe(started.revisionId);
  expect(replayed.inputShas).toEqual(started.inputShas);
  expect(await kinds('review.run.start')).toEqual(after);

  await expect(startCanonicalRun({ ...start, branch: 'other-branch' })).rejects.toMatchObject(
    CONFLICT
  );
  expect(await kinds('review.run.start')).toEqual(after);
}, 300_000);

it('replays a served lane and a submitted attempt, and refuses a different lane or payload', async () => {
  const runId = (
    await startCanonicalRun({
      ...locator(),
      profile: 'routine',
      createdAt: '2026-06-11T00:04:00.000Z',
      runtimeIdentity: null,
      executionProfile: EXECUTION_PROFILE,
      operationId: uuidv7(),
      secretAllow: [],
    })
  ).runId;

  const serveId = uuidv7();
  const serve = {
    ...locator(),
    runId,
    lane: 'forensic' as const,
    servedAt: '2026-06-11T00:05:00.000Z',
    operationId: serveId,
    secretAllow: [],
  };
  const served = await recordCanonicalLaneServed(serve);
  expect(served.recorded).toBe(true);
  const afterServe = await kinds('review.run.inputs-served');

  const replayedServe = await recordCanonicalLaneServed({
    ...serve,
    servedAt: '2026-06-11T00:06:00.000Z',
  });
  expect(replayedServe.recorded).toBe(false);
  expect(replayedServe.servedAt).toBe('2026-06-11T00:05:00.000Z');
  expect(await kinds('review.run.inputs-served')).toEqual(afterServe);

  await expect(recordCanonicalLaneServed({ ...serve, lane: 'account' })).rejects.toMatchObject(
    CONFLICT
  );
  expect(await kinds('review.run.inputs-served')).toEqual(afterServe);

  const submitId = uuidv7();
  const submit = {
    ...locator(),
    runId,
    lane: 'forensic' as const,
    at: '2026-06-11T00:07:00.000Z',
    isolation: 'sequential' as const,
    usageTokens: null,
    usageSource: null,
    runtimeIdentity: null,
    rawSubmission: FORENSIC,
    operationId: submitId,
    secretAllow: [],
  };
  const submitted = await submitCanonicalLane(submit);
  expect(submitted.replayed).toBe(false);
  expect(submitted.accepted).toBe(true);
  const afterSubmit = await kinds('review.run.attempt');

  const replayedSubmit = await submitCanonicalLane({ ...submit, at: '2026-06-11T00:08:00.000Z' });
  expect(replayedSubmit.replayed).toBe(true);
  expect(replayedSubmit.accepted).toBe(true);
  expect(replayedSubmit.run.attempts).toHaveLength(submitted.run.attempts.length);
  expect(await kinds('review.run.attempt')).toEqual(afterSubmit);

  await expect(
    submitCanonicalLane({
      ...submit,
      rawSubmission: JSON.stringify({ findings: [], questions: [] }),
    })
  ).rejects.toMatchObject(CONFLICT);
  expect(await kinds('review.run.attempt')).toEqual(afterSubmit);
}, 300_000);

it('replays a sealed run under its original identity and refuses a different run', async () => {
  const started = await startCanonicalRun({
    ...locator(),
    profile: 'routine',
    createdAt: '2026-06-11T00:09:00.000Z',
    runtimeIdentity: null,
    executionProfile: EXECUTION_PROFILE,
    operationId: uuidv7(),
    secretAllow: [],
  });
  await submitCanonicalLane({
    ...locator(),
    runId: started.runId,
    lane: 'forensic',
    at: '2026-06-11T00:10:00.000Z',
    isolation: 'sequential',
    usageTokens: null,
    usageSource: null,
    runtimeIdentity: null,
    rawSubmission: FORENSIC,
    operationId: uuidv7(),
    secretAllow: [],
  });

  const operationId = uuidv7();
  const finalize = {
    ...locator(),
    runId: started.runId,
    finalizedAt: '2026-06-11T00:11:00.000Z',
    runtimeIdentity: null,
    operationId,
    secretAllow: [],
  };
  const sealed = await finalizeCanonicalRun(finalize);
  expect(sealed).toMatchObject({ status: 'sealed', replayed: false });
  const after = await kinds('review.run.finalize');

  const replayed = await finalizeCanonicalRun({
    ...finalize,
    finalizedAt: '2026-06-11T00:12:00.000Z',
  });
  expect(replayed).toMatchObject({ status: 'sealed', replayed: true });
  expect(replayed.terminal).toEqual(sealed.terminal);
  expect(replayed.storyPublicationId).toBe(sealed.storyPublicationId);
  expect(await kinds('review.run.finalize')).toEqual(after);

  await expect(
    finalizeCanonicalRun({ ...finalize, runId: '00000000-0000-4000-8000-000000000000' })
  ).rejects.toMatchObject(CONFLICT);
  expect(await kinds('review.run.finalize')).toEqual(after);
}, 300_000);

it('replays an authored comment under its original identity and refuses a different body', async () => {
  const published = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-11T00:13:00.000Z',
    secretAllow: [],
  });
  const retained = await readDatabaseReviewFloor({
    authority: fixture.authority,
    reviewId: published.review_id,
    publicationId: published.publication_id,
  });
  const hunks = parsePatchHunks(
    Buffer.from(retained.value!.diffBytes).toString('utf8'),
    new Set(published.floor.coverage.items.map((entry) => entry.file))
  );
  const anchored = hunks
    .flatMap((hunk) => hunk.lines.map((line) => ({ hunk, line })))
    .find((entry) => entry.line.side === 'add' && entry.line.body.trim().length > 0);
  expect(anchored, 'the published diff carries an added line to anchor on').toBeDefined();
  const item = published.floor.coverage.items.find((entry) => entry.file === anchored!.hunk.file);
  expect(item, 'the floor covers the anchored file').toBeDefined();

  const add = async (body: string, commentId: string) => ({
    branch: fixture.branch,
    cwd: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    events: [
      {
        type: 'add' as const,
        comment_id: commentId,
        ts: '2026-06-11T00:14:00.000Z',
        author: 'reviewer' as const,
        body,
        anchor: {
          kind: 'DIFF_LINE' as const,
          file: anchored!.hunk.file,
          side: 'add' as const,
          line: anchored!.line.new!,
          lineHash: await lineHash('add', new TextEncoder().encode(anchored!.line.body)),
          hunkKey: item!.hunkKey,
        },
      },
    ],
    secretAllow: [],
  });

  const operationId = uuidv7();
  const created = await applyDatabaseReviewComments({
    ...(await add('the original body', uuidv7())),
    operationId,
  });
  expect(created.replayed).toBe(false);
  const after = await kinds('review.comment.add');

  // A retried `review comment add` mints a fresh comment identity, so the
  // replay keys on what the reviewer authored, not on the minted id.
  const replayed = await applyDatabaseReviewComments({
    ...(await add('the original body', uuidv7())),
    operationId,
  });
  expect(replayed.replayed).toBe(true);
  expect(await kinds('review.comment.add')).toEqual(after);

  await expect(
    applyDatabaseReviewComments({ ...(await add('a different body', uuidv7())), operationId })
  ).rejects.toMatchObject(CONFLICT);
  expect(await kinds('review.comment.add')).toEqual(after);
}, 300_000);

it('replays a comment reply/status append batch and refuses a different one under its identity', async () => {
  const published = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-11T00:19:00.000Z',
    secretAllow: [],
  });
  const retained = await readDatabaseReviewFloor({
    authority: fixture.authority,
    reviewId: published.review_id,
    publicationId: published.publication_id,
  });
  const hunks = parsePatchHunks(
    Buffer.from(retained.value!.diffBytes).toString('utf8'),
    new Set(published.floor.coverage.items.map((entry) => entry.file))
  );
  const anchored = hunks
    .flatMap((hunk) => hunk.lines.map((line) => ({ hunk, line })))
    .find((entry) => entry.line.side === 'add' && entry.line.body.trim().length > 0)!;
  const item = published.floor.coverage.items.find((entry) => entry.file === anchored.hunk.file)!;
  const base = {
    branch: fixture.branch,
    cwd: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    secretAllow: [],
  };

  const commentId = uuidv7();
  await applyDatabaseReviewComments({
    ...base,
    operationId: uuidv7(),
    events: [
      {
        type: 'add',
        comment_id: commentId,
        ts: '2026-06-11T00:20:00.000Z',
        author: 'reviewer',
        body: 'the anchored question',
        anchor: {
          kind: 'DIFF_LINE',
          file: anchored.hunk.file,
          side: 'add',
          line: anchored.line.new!,
          lineHash: await lineHash('add', new TextEncoder().encode(anchored.line.body)),
          hunkKey: item.hunkKey,
        },
      },
    ],
  });

  // A reply-and-status batch is a review.comment.append, addressed by the
  // caller's own operation identity (not a derived child).
  const appendBatch = (body: string) => ({
    ...base,
    operationId,
    events: [
      {
        type: 'reply' as const,
        comment_id: commentId,
        ts: '2026-06-11T00:21:00.000Z',
        author: 'agent' as const,
        body,
      },
      {
        type: 'status' as const,
        comment_id: commentId,
        ts: '2026-06-11T00:21:01.000Z',
        author: 'agent' as const,
        status: 'resolved' as const,
      },
    ],
  });

  const operationId = uuidv7();
  const appended = await applyDatabaseReviewComments(appendBatch('answered: it is bounded'));
  expect(appended.replayed).toBe(false);
  const afterAppend = await kinds('review.comment.append');
  const rowsAfterAppend = await commentRevisionRows();

  // Retry the identical batch under the same identity: it replays, adding no
  // second reply/status revision.
  const replayed = await applyDatabaseReviewComments(appendBatch('answered: it is bounded'));
  expect(replayed.replayed).toBe(true);
  expect(await kinds('review.comment.append')).toEqual(afterAppend);
  expect(await commentRevisionRows()).toEqual(rowsAfterAppend);

  // A differently authored append under the same identity is a conflict, and
  // still adds nothing.
  await expect(
    applyDatabaseReviewComments(appendBatch('answered: it is not'))
  ).rejects.toMatchObject(CONFLICT);
  expect(await kinds('review.comment.append')).toEqual(afterAppend);
  expect(await commentRevisionRows()).toEqual(rowsAfterAppend);
}, 300_000);

it('replays a combined add-plus-revisions batch and refuses a different one under its identity', async () => {
  const published = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-11T00:23:00.000Z',
    secretAllow: [],
  });
  const retained = await readDatabaseReviewFloor({
    authority: fixture.authority,
    reviewId: published.review_id,
    publicationId: published.publication_id,
  });
  const hunks = parsePatchHunks(
    Buffer.from(retained.value!.diffBytes).toString('utf8'),
    new Set(published.floor.coverage.items.map((entry) => entry.file))
  );
  const anchored = hunks
    .flatMap((hunk) => hunk.lines.map((line) => ({ hunk, line })))
    .find((entry) => entry.line.side === 'add' && entry.line.body.trim().length > 0)!;
  const item = published.floor.coverage.items.find((entry) => entry.file === anchored.hunk.file)!;

  const commentId = uuidv7();
  const operationId = uuidv7();
  const addEvent = {
    type: 'add' as const,
    comment_id: commentId,
    ts: '2026-06-11T00:24:00.000Z',
    author: 'reviewer' as const,
    body: 'the anchored question',
    anchor: {
      kind: 'DIFF_LINE' as const,
      file: anchored.hunk.file,
      side: 'add' as const,
      line: anchored.line.new!,
      lineHash: await lineHash('add', new TextEncoder().encode(anchored.line.body)),
      hunkKey: item.hunkKey,
    },
  };
  // One batch mints the comment AND appends its revisions: the add settles under
  // the caller's identity, the tail under the derived append child.
  const batch = (reply: string) => ({
    branch: fixture.branch,
    cwd: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId,
    events: [
      addEvent,
      {
        type: 'reply' as const,
        comment_id: commentId,
        ts: '2026-06-11T00:24:01.000Z',
        author: 'agent' as const,
        body: reply,
      },
      {
        type: 'status' as const,
        comment_id: commentId,
        ts: '2026-06-11T00:24:02.000Z',
        author: 'agent' as const,
        status: 'resolved' as const,
      },
    ],
    secretAllow: [],
  });

  const created = await applyDatabaseReviewComments(batch('answered: it is bounded'));
  expect(created.replayed).toBe(false);
  const appendId = deriveReviewOperationId(operationId, 'review.comment.append');
  expect((await receipts()).map((row) => row.operation_id)).toContain(appendId);
  const afterAdd = await kinds('review.comment.add');
  const afterAppend = await kinds('review.comment.append');
  const rowsAfter = await commentRevisionRows();

  // Retry the whole batch under the same identity: the add and its tail both
  // replay, byte-identical, adding no second comment or revisions.
  const replayed = await applyDatabaseReviewComments(batch('answered: it is bounded'));
  expect(replayed.replayed).toBe(true);
  expect(replayed.value).toEqual(created.value);
  expect(await kinds('review.comment.add')).toEqual(afterAdd);
  expect(await kinds('review.comment.append')).toEqual(afterAppend);
  expect(await commentRevisionRows()).toEqual(rowsAfter);

  // The same identity carrying a different revision refuses and adds nothing.
  await expect(applyDatabaseReviewComments(batch('answered: it is not'))).rejects.toMatchObject(
    CONFLICT
  );
  expect(await commentRevisionRows()).toEqual(rowsAfter);
}, 300_000);

it('settles the tail exactly once when a combined batch was interrupted after its add', async () => {
  const published = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-11T00:29:00.000Z',
    secretAllow: [],
  });
  const retained = await readDatabaseReviewFloor({
    authority: fixture.authority,
    reviewId: published.review_id,
    publicationId: published.publication_id,
  });
  const hunks = parsePatchHunks(
    Buffer.from(retained.value!.diffBytes).toString('utf8'),
    new Set(published.floor.coverage.items.map((entry) => entry.file))
  );
  const anchored = hunks
    .flatMap((hunk) => hunk.lines.map((line) => ({ hunk, line })))
    .find((entry) => entry.line.side === 'add' && entry.line.body.trim().length > 0)!;
  const item = published.floor.coverage.items.find((entry) => entry.file === anchored.hunk.file)!;

  const commentId = uuidv7();
  const operationId = uuidv7();
  const addEvent = {
    type: 'add' as const,
    comment_id: commentId,
    ts: '2026-06-11T00:30:00.000Z',
    author: 'reviewer' as const,
    body: 'the anchored question',
    anchor: {
      kind: 'DIFF_LINE' as const,
      file: anchored.hunk.file,
      side: 'add' as const,
      line: anchored.line.new!,
      lineHash: await lineHash('add', new TextEncoder().encode(anchored.line.body)),
      hunkKey: item.hunkKey,
    },
  };
  const tail = [
    {
      type: 'reply' as const,
      comment_id: commentId,
      ts: '2026-06-11T00:30:01.000Z',
      author: 'agent' as const,
      body: 'answered: it is bounded',
    },
    {
      type: 'status' as const,
      comment_id: commentId,
      ts: '2026-06-11T00:30:02.000Z',
      author: 'agent' as const,
      status: 'resolved' as const,
    },
  ];
  const base = {
    branch: fixture.branch,
    cwd: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    secretAllow: [],
  };

  // A batch interrupted after its add settles the add under the caller's identity
  // and leaves the tail's derived append identity uncommitted — exactly the state
  // an add-only invocation under the same identity produces.
  const partial = await applyDatabaseReviewComments({ ...base, operationId, events: [addEvent] });
  expect(partial.replayed).toBe(false);
  const appendId = deriveReviewOperationId(operationId, 'review.comment.append');
  expect((await receipts()).map((row) => row.operation_id)).not.toContain(appendId);
  const rowsAfterAdd = await commentRevisionRows();

  // Retrying the FULL batch resumes the missing tail — it settles once, is not a
  // false replay, and mints exactly the two missing revisions.
  const resumed = await applyDatabaseReviewComments({
    ...base,
    operationId,
    events: [addEvent, ...tail],
  });
  expect(resumed.replayed).toBe(false);
  expect(resumed.value.version).toBe(3);
  expect((await receipts()).map((row) => row.operation_id)).toContain(appendId);
  const rowsAfterTail = await commentRevisionRows();
  expect(rowsAfterTail.length).toBe(rowsAfterAdd.length + 2);

  // A further retry now replays the settled tail, adding nothing.
  const replayed = await applyDatabaseReviewComments({
    ...base,
    operationId,
    events: [addEvent, ...tail],
  });
  expect(replayed.replayed).toBe(true);
  expect(replayed.value).toEqual(resumed.value);
  expect(await commentRevisionRows()).toEqual(rowsAfterTail);
}, 300_000);

it('replays an authored disposition under its original identity and refuses a different event', async () => {
  const published = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-11T00:15:00.000Z',
    secretAllow: [],
  });
  const threadKey = published.floor.outline.threads[0]!.threadKey;
  const operationId = uuidv7();
  const event = (action: 'VISIT' | 'SKIP') => ({
    branch: fixture.branch,
    cwd: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId,
    events: [
      {
        type: 'section' as const,
        ts: '2026-06-11T00:16:00.000Z',
        threadKey,
        action,
        ...(action === 'SKIP' ? { reason: 'not reviewed' } : {}),
      },
    ],
    secretAllow: [],
  });

  const applied = await applyDatabaseReviewWorkflow(event('VISIT'));
  expect(applied.replayed).toBe(false);
  const after = await kinds('review.workflow.append');

  const replayed = await applyDatabaseReviewWorkflow(event('VISIT'));
  expect(replayed.replayed).toBe(true);
  expect(replayed.value).toEqual(applied.value);
  expect(await kinds('review.workflow.append')).toEqual(after);

  await expect(applyDatabaseReviewWorkflow(event('SKIP'))).rejects.toMatchObject(CONFLICT);
  expect(await kinds('review.workflow.append')).toEqual(after);
}, 300_000);

it('refuses an identity that belongs to another authored action', async () => {
  const operationId = uuidv7();
  await startCanonicalRun({
    ...locator(),
    profile: 'routine',
    createdAt: '2026-06-11T00:17:00.000Z',
    runtimeIdentity: null,
    executionProfile: EXECUTION_PROFILE,
    operationId,
    secretAllow: [],
  });
  await expect(
    applyDatabaseReviewWorkflow({
      branch: fixture.branch,
      cwd: fixture.gitRoot,
      dataRoot: fixture.dataRoot,
      projectId: fixture.projectId,
      operationId,
      events: [
        {
          type: 'section' as const,
          ts: '2026-06-11T00:18:00.000Z',
          threadKey: 'any-thread',
          action: 'VISIT' as const,
        },
      ],
      secretAllow: [],
    })
  ).rejects.toMatchObject(CONFLICT);
}, 300_000);

it('answers the change probe with the same Story generations the full pane reports', async () => {
  const published = await executeDatabaseReviewData({
    branch: fixture.branch,
    root: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-11T00:25:00.000Z',
    secretAllow: [],
  });
  const started = await startCanonicalRun({
    ...locator(),
    profile: 'routine',
    createdAt: '2026-06-11T00:26:00.000Z',
    runtimeIdentity: null,
    executionProfile: EXECUTION_PROFILE,
    operationId: uuidv7(),
    secretAllow: [],
  });
  await submitCanonicalLane({
    ...locator(),
    runId: started.runId,
    lane: 'forensic',
    at: '2026-06-11T00:27:00.000Z',
    isolation: 'sequential',
    usageTokens: null,
    usageSource: null,
    runtimeIdentity: null,
    rawSubmission: FORENSIC,
    operationId: uuidv7(),
    secretAllow: [],
  });
  const sealed = await finalizeCanonicalRun({
    ...locator(),
    runId: started.runId,
    finalizedAt: '2026-06-11T00:28:00.000Z',
    runtimeIdentity: null,
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(sealed.status).toBe('sealed');

  const paneLocator = {
    branch: fixture.branch,
    cwd: fixture.gitRoot,
    dataRoot: fixture.dataRoot,
    projectId: fixture.projectId,
  };
  const pane = (await readDatabaseReviewPane(paneLocator))!;
  const probe = (await readDatabaseReviewPaneGenerations(paneLocator))!;
  // The sealed Story makes the story and installation tokens non-null, so this
  // exercises the focused read's Story path, not just the floor-only tokens.
  expect(pane.generations.story).not.toBeNull();
  expect(pane.generations.storyInstallation).toBe(started.runId);
  expect(probe.generations).toEqual(pane.generations);
  expect(probe.reviewId).toBe(published.review_id);
}, 300_000);

it('derives a stable child identity that is neither the parent nor another label', () => {
  const parent = uuidv7();
  expect(deriveReviewOperationId(parent, 'review.floor')).toBe(
    deriveReviewOperationId(parent, 'review.floor')
  );
  expect(deriveReviewOperationId(parent, 'review.floor')).not.toBe(parent);
  expect(deriveReviewOperationId(parent, 'review.floor')).not.toBe(
    deriveReviewOperationId(parent, 'review.resolution')
  );
  expect(deriveReviewOperationId(parent, 'review.floor')).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  expect(deriveReviewOperationId(parent, 'review.floor').slice(0, 13)).toBe(parent.slice(0, 13));
});
