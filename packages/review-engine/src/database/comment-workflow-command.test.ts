import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { lineHash } from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import { applyDatabaseReviewComments } from './comment-command.js';
import { executeDatabaseReviewData } from './floor-command.js';
import { readDatabaseReviewPane, readDatabaseReviewPaneGenerations } from './pane.js';
import { readDatabaseReviewContext, readDatabaseReviewWorkflowContext } from './read-context.js';
import { applyDatabaseReviewWorkflow } from './workflow-command.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/storage/history/database')>()),
  openProjectDatabase: vi.fn(
    (await importOriginal<typeof import('@orcaops/storage/history/database')>()).openProjectDatabase
  ),
  // Reading retained evidence bytes is the heavy hydration a full pane/context
  // does and a focused read must not: spy on it to prove the scope of each read.
  readProjectEvidence: vi.fn(
    (await importOriginal<typeof import('@orcaops/storage/history/database')>()).readProjectEvidence
  ),
}));

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]) {
  return (
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', ...args], {
      cwd,
    })
  ).stdout.trim();
}

const ADDED_LINE = 'export const added = true;';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'review-comment-'));
  roots.push(root);
  const gitRoot = path.join(root, 'repo');
  await mkdir(gitRoot);
  await git(gitRoot, ['init', '--quiet', '--initial-branch=main']);
  await mkdir(path.join(gitRoot, 'src'));
  await writeFile(path.join(gitRoot, 'src', 'a.ts'), 'export const baseline = true;\n');
  await git(gitRoot, ['add', '-A']);
  await git(gitRoot, ['commit', '--quiet', '-m', 'Original base']);
  await writeFile(
    path.join(gitRoot, 'src', 'a.ts'),
    `export const baseline = true;\n${ADDED_LINE}\n`
  );
  await git(gitRoot, ['add', '-A']);
  const authority = (
    await setupProjectDatabase({
      cwd: gitRoot,
      root: path.join(root, 'history'),
      authoredPayloads: [],
      secretAllow: [],
    })
  ).initialization.authority;
  const dataRoot = path.join(root, 'history');
  await executeDatabaseReviewData({
    branch: 'main',
    root: gitRoot,
    dataRoot,
    projectId: authority.projectId,
    operationId: uuidv7(),
    generatedAt: '2026-06-01T00:00:00.000Z',
    secretAllow: [],
  });
  return { root, gitRoot, dataRoot, authority };
}

function comments(f: Awaited<ReturnType<typeof fixture>>, events: unknown[]) {
  return applyDatabaseReviewComments({
    branch: 'main',
    cwd: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.authority.projectId,
    operationId: uuidv7(),
    events: events as Parameters<typeof applyDatabaseReviewComments>[0]['events'],
    secretAllow: [],
  });
}

async function context(f: Awaited<ReturnType<typeof fixture>>) {
  return readDatabaseReviewContext({
    branch: 'main',
    cwd: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.authority.projectId,
  });
}

async function add(id: string) {
  return {
    type: 'add',
    comment_id: id,
    ts: '2026-06-01T00:05:00.000Z',
    author: 'reviewer',
    body: 'why this base?',
    anchor: {
      kind: 'DIFF_LINE',
      file: 'src/a.ts',
      side: 'add',
      line: 2,
      lineHash: await lineHash('add', new TextEncoder().encode(ADDED_LINE)),
    },
  };
}

it('retains an authored comment under its original identity', async () => {
  const f = await fixture();
  const id = uuidv7();
  await comments(f, [await add(id)]);
  const read = await context(f);
  expect(read.comments.comments.map((comment) => comment.commentId)).toEqual([id]);
  expect(read.comments.heads).toEqual([
    { commentId: id, revisionId: expect.any(String), version: 1 },
  ]);
}, 60_000);

it('appends a reply and a resolve as revisions on the same comment identity', async () => {
  const f = await fixture();
  const id = uuidv7();
  await comments(f, [await add(id)]);
  await comments(f, [
    {
      type: 'reply',
      comment_id: id,
      ts: '2026-06-01T00:06:00.000Z',
      author: 'agent',
      body: 'pinned in cp2',
    },
    {
      type: 'status',
      comment_id: id,
      ts: '2026-06-01T00:06:00.000Z',
      author: 'agent',
      status: 'resolved',
    },
  ]);
  const read = await context(f);
  expect(read.comments.heads).toEqual([
    { commentId: id, revisionId: expect.any(String), version: 3 },
  ]);
  const [comment] = read.comments.comments;
  expect(comment!.revisions).toHaveLength(3);
  expect(comment!.revisions.map((revision) => revision.event.type)).toEqual([
    'add',
    'reply',
    'status',
  ]);
}, 60_000);

it('refuses an append against an unknown comment identity', async () => {
  const f = await fixture();
  await expect(
    comments(f, [
      {
        type: 'status',
        comment_id: uuidv7(),
        ts: '2026-06-01T00:06:00.000Z',
        author: 'reviewer',
        status: 'resolved',
      },
    ])
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
}, 60_000);

it('refuses a batch that mixes comment identities before any write', async () => {
  const f = await fixture();
  vi.mocked(store.openProjectDatabase).mockClear();
  await expect(comments(f, [await add(uuidv7()), await add(uuidv7())])).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
}, 60_000);

it('reads a consistent empty workflow history for a review with no disposition yet', async () => {
  const f = await fixture();
  const read = await context(f);
  expect(read.workflow.sequence).toBe(0);
  expect(read.workflow.events).toEqual([]);
  expect(read.workflow.heads).toEqual([]);
  expect(read.workflow.ledgerGeneration).toEqual(expect.any(String));
}, 60_000);

it('refuses a workflow event whose section is absent from the selected floor', async () => {
  const f = await fixture();
  await expect(
    applyDatabaseReviewWorkflow({
      branch: 'main',
      cwd: f.gitRoot,
      dataRoot: f.dataRoot,
      projectId: f.authority.projectId,
      operationId: uuidv7(),
      events: [
        {
          type: 'section',
          threadKey: 'absent-thread-key',
          ts: '2026-06-01T00:07:00.000Z',
          action: 'VISIT',
          reason: 'not a real thread',
        },
      ] as Parameters<typeof applyDatabaseReviewWorkflow>[0]['events'],
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
}, 60_000);

it('answers the generations-only pane probe from change tokens without reading evidence', async () => {
  const f = await fixture();
  await comments(f, [await add(uuidv7())]);
  const locator = {
    branch: 'main',
    cwd: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.authority.projectId,
  };

  // The full pane hydrates the floor and diff from retained evidence.
  vi.mocked(store.readProjectEvidence).mockClear();
  const pane = await readDatabaseReviewPane(locator);
  expect(store.readProjectEvidence).toHaveBeenCalled();
  expect(pane).not.toBeNull();

  // The focused probe returns the same tokens and reads no evidence at all.
  vi.mocked(store.readProjectEvidence).mockClear();
  const probe = await readDatabaseReviewPaneGenerations(locator);
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  expect(probe).not.toBeNull();
  expect(probe!.generations).toEqual(pane!.generations);
}, 60_000);

it('reads only the workflow slice for a disposition append', async () => {
  const f = await fixture();
  const locator = {
    branch: 'main',
    cwd: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.authority.projectId,
  };

  vi.mocked(store.readProjectEvidence).mockClear();
  const slice = await readDatabaseReviewWorkflowContext(locator);
  expect(store.readProjectEvidence).not.toHaveBeenCalled();
  expect(slice.floor).not.toBeNull();
  expect(slice.workflow.heads).toEqual([]);

  // The full context read of the same review does hydrate its retained evidence.
  vi.mocked(store.readProjectEvidence).mockClear();
  await readDatabaseReviewContext(locator);
  expect(store.readProjectEvidence).toHaveBeenCalled();
}, 60_000);
