import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import * as scopes from '@orcaops/project-scope/history/database';
import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import * as store from '@orcaops/storage/history/database';

import { parseReviewArgs, runReview } from '../run.js';
import { createDatabaseReview } from './reviews.js';

vi.mock('@orcaops/project-scope/history/database', async (original) => ({
  ...(await original<typeof scopes>()),
}));
const roots: string[] = [];
const handles: store.ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'review-health-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(store.projectDatabasePath(authority)), { recursive: true });
  const db = await store.initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-06-01T00:00:00.000Z',
    authorize() {},
  });
  handles.push(db);
  const env = { ORCAOPS_DATA_DIR: root.resolvedRoot, ORCAOPS_ROOT: root.resolvedRoot };
  const out: string[] = [],
    err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { authority, db, env, out, err };
}
async function review(f: Awaited<ReturnType<typeof fixture>>, branch: string | null) {
  const reviewId = uuidv7(),
    operationId = uuidv7();
  await createDatabaseReview({
    authority: f.authority,
    operationId,
    secretAllow: [],
    identityBytes: bytes({
      schema_version: 1,
      review_id: reviewId,
      project_id: f.authority.projectId,
      store_instance_id: f.authority.storeInstanceId,
      repository_instance_id: f.authority.repositoryInstanceId,
      created_by_operation: operationId,
      initial_context: { worktree_id: null, branch, base_sha: null, head_sha: null },
      artifact_ids: [],
      legacy_source_ids: [],
    }),
    membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
  });
  return reviewId;
}
const argv = (project: string, selector: string[]) => [
  'review',
  'state',
  'health',
  '--project',
  project,
  ...selector,
  '--json',
];
it('emits branchless canonical health after closing its readonly scope', async () => {
  const f = await fixture(),
    id = await review(f, null),
    before = f.db.read(() => null).counters;
  const files = await readdir(f.authority.resolvedRoot, { recursive: true });
  const original = scopes.resolveDatabaseHistoryScope;
  let closed = false;
  vi.spyOn(scopes, 'resolveDatabaseHistoryScope').mockImplementation(async (input) => {
    const scope = await original(input);
    return {
      ...scope,
      close() {
        scope.close();
        closed = true;
      },
    };
  });
  const writing = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    expect(closed).toBe(true);
    f.out.push(String(chunk));
    return true;
  });
  expect(await runReview(argv(f.authority.projectId, ['--review', id]), f.env)).toBe(0);
  expect(writing).toHaveBeenCalledOnce();
  const result = JSON.parse(f.out[0]!);
  expect(result).toMatchObject({
    schema_version: 3,
    status: 'HEALTHY',
    project_id: f.authority.projectId,
    review_id: id,
    branch: null,
    counters: before,
  });
  expect(
    result.states.map((state: { kind: string; status: string }) => [state.kind, state.status])
  ).toEqual([
    ['REVIEW_STATE', 'HEALTHY'],
    ['FLOOR', 'ABSENT'],
    ['STORY', 'ABSENT'],
    ['COMMENTS', 'HEALTHY'],
    ['JOURNAL', 'HEALTHY'],
  ]);
  expect(result.repair.command).toBeUndefined();
  expect(result.states.every((state: object) => !('path' in state))).toBe(true);
  expect(f.db.read(() => null).counters).toEqual(before);
  expect(await readdir(f.authority.resolvedRoot, { recursive: true })).toEqual(files);
});
it('returns qualified ambiguity and accepts its exact review choice', async () => {
  const f = await fixture(),
    first = await review(f, 'topic');
  await review(f, 'topic');
  await review(f, 'topic');
  expect(await runReview(argv(f.authority.projectId, ['--branch', 'topic']), f.env)).toBe(1);
  const result = JSON.parse(f.out.at(-1)!);
  expect(result).toMatchObject({ ok: false, code: 'REVIEW_SELECTION_REQUIRED', truncated: true });
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[0].command).toContain(`--project ${f.authority.projectId} --review `);
  expect(await runReview(argv(f.authority.projectId, ['--review', first]), f.env)).toBe(0);
  expect(JSON.parse(f.out.at(-1)!).review_id).toBe(first);
});
it('freezes the original public selectors and environment before scope discovery', async () => {
  const f = await fixture(),
    id = await review(f, 'topic'),
    args = argv(f.authority.projectId, ['--review', id]);
  const pending = runReview(args, f.env);
  args[4] = uuidv7();
  f.env.ORCAOPS_DATA_DIR = '/changed';
  f.env.ORCAOPS_ROOT = '/changed';
  expect(await pending).toBe(0);
  expect(JSON.parse(f.out.at(-1)!).review_id).toBe(id);
});
it('rejects missing or unrelated health flags and does not add selectors to writer verbs', async () => {
  const f = await fixture(),
    spy = vi.spyOn(scopes, 'resolveDatabaseHistoryScope');
  for (const args of [
    ['review', 'state', 'health', '--project'],
    ['review', 'state', 'health', '--review', '--json'],
    ['review', 'state', 'health', '--branch', 'topic', '--base', 'HEAD'],
    ['review', 'state', 'repair', '--project', uuidv7()],
    ['review', 'start', '--review', uuidv7()],
  ])
    expect(await runReview(args, f.env)).toBe(2);
  expect(spy).not.toHaveBeenCalled();
  expect(
    parseReviewArgs(['review', 'state', 'health', '--project', 'p', '--review', 'r'])
  ).toMatchObject({ projectId: 'p', reviewId: 'r' });
});
it('returns typed missing history without initializing a replacement or rendering raw causes', async () => {
  const f = await fixture();
  const missing = uuidv7(),
    before = await readdir(f.authority.resolvedRoot, { recursive: true });
  expect(await runReview(argv(missing, ['--review', uuidv7()]), f.env)).toBe(1);
  const result = JSON.parse(f.out.at(-1)!);
  expect(result).toMatchObject({ ok: false, schema_version: 3, code: 'HISTORY_MISSING' });
  expect(result.cause).toBeUndefined();
  expect(result.context).toBeUndefined();
  expect(await readdir(f.authority.resolvedRoot, { recursive: true })).toEqual(before);
});
it('prints local health help without resolving project history', async () => {
  const f = await fixture(),
    spy = vi.spyOn(scopes, 'resolveDatabaseHistoryScope');
  expect(await runReview(['review', 'state', 'health', '--help'], f.env)).toBe(0);
  expect(f.out[0]).toContain('--review <uuid>');
  expect(spy).not.toHaveBeenCalled();
});
it('keeps missing-review classification when closing its genuine reader also fails', async () => {
  const f = await fixture(),
    original = scopes.resolveDatabaseHistoryScope;
  let closed = false;
  vi.spyOn(scopes, 'resolveDatabaseHistoryScope').mockImplementation(async (input) => {
    const scope = await original(input);
    return {
      ...scope,
      close() {
        scope.close();
        closed = true;
        throw new Error('private controlled cleanup cause');
      },
    };
  });
  expect(await runReview(argv(f.authority.projectId, ['--review', uuidv7()]), f.env)).toBe(1);
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ code: 'REVIEW_NOT_FOUND', ok: false });
  expect(f.out.join('')).not.toContain('private controlled cleanup cause');
  expect(closed).toBe(true);
  expect(f.db.read(() => true).value).toBe(true);
});
it('returns machine-readable selector refusal without opening authority', async () => {
  const f = await fixture(),
    spy = vi.spyOn(scopes, 'resolveDatabaseHistoryScope');
  for (const selector of [
    ['--review'],
    ['--review', 'prefix'],
    ['--branch', ' '],
    ['--base', 'HEAD'],
  ]) {
    expect(await runReview(['review', 'state', 'health', ...selector, '--json'], f.env)).toBe(2);
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({
      schema_version: 3,
      code: 'INVALID_INPUT',
      ok: false,
    });
  }
  expect(spy).not.toHaveBeenCalled();
});
it('reports the same health whether or not stray files sit in a review directory', async () => {
  const f = await fixture(),
    id = await review(f, null);
  expect(await runReview(argv(f.authority.projectId, ['--review', id]), f.env)).toBe(0);
  const clean = JSON.parse(f.out.at(-1)!);

  // The retired durable-state surface inspected a review directory, so a stray
  // composition file could change what health reported. Canonical health reads
  // retained rows, so nothing written beside them can move it.
  const reviewDir = path.join(f.authority.resolvedRoot, '.orcaops', 'reviews', 'demo');
  await mkdir(reviewDir, { recursive: true });
  await writeFile(path.join(reviewDir, 'compose-session-v1.json'), '{broken session');
  await writeFile(path.join(reviewDir, 'narrative.json'), '{broken narrative');
  await writeFile(path.join(reviewDir, 'journal.ndjson'), 'not json\n');
  await writeFile(path.join(reviewDir, 'comments.ndjson'), 'not json\n');

  expect(await runReview(argv(f.authority.projectId, ['--review', id]), f.env)).toBe(0);
  expect(JSON.parse(f.out.at(-1)!)).toEqual(clean);
});
