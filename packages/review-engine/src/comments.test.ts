// Headless round-trip for the comment verbs: add → reply → resolve against a
// cached floor + pinned diff (the re-anchor ladder, owner, trail, ±context all
// come back on the enriched read), plus slug safety, unknown-id rejection,
// fail-closed sidecar health, and the floor-absent degrade.

import { execFileSync } from 'node:child_process';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CITATION_KIND,
  contextLineHash,
  FLOOR_SCHEMA_VERSION,
  lineHash,
} from '@orcaops/review-core';
import { archiveProjectDir, archiveReviewPaths } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { REVIEW_ARCHIVE_WARNING_CODE } from './archive.js';
import type { CommentsPayload } from './comments.js';
import { parsePatchHunks, runCommentAction, runComments } from './comments.js';
import { ensureReviewStateVersion, REVIEW_STATE_VERSION } from './reviewState.js';
import type { ReviewArgs } from './run.js';

const A = '019f38b7-1111-7000-8000-000000000001';
const ANCHOR_BODY = 'const answer = compute(42);';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 0000000..1111111 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' import { compute } from "./calc";',
  '+const answer = compute(42);',
  ' export function main() {',
  ' }',
  '',
].join('\n');

function makeFloor() {
  return {
    schema_version: FLOOR_SCHEMA_VERSION,
    input_hash: 'h',
    generated_at: '2026-07-09T00:00:00.000Z',
    scope: {
      branch: 'demo',
      branch_slug: 'demo',
      base_sha: 'base',
      pinned_tree_sha: 'tree',
      head_sha: null,
      default_branch: null,
      artifact_ids: [A],
      threads: [
        {
          artifact: A,
          branch: 'demo',
          label: 'demo thread',
          first_activity_at: null,
        },
      ],
    },
    coverage: {
      items: [
        {
          hunkKey: 'hunk_1',
          file: 'src/a.ts',
          verdict: 'MATCHED',
          old_start: 1,
          new_start: 1,
          added_lines: 1,
          removed_lines: 0,
          units: [
            {
              kind: 'owned_slice',
              slice: 0,
              patch_row_start: 1,
              patch_row_end: 1,
              del_range: null,
              add_range: { start: 2, end: 2 },
              lines: 1,
              owner: { kind: 'checkpoint', artifact: A, cp: 1 },
            },
          ],
        },
      ],
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: 1,
        unexplained_rows: 0,
        ambiguous_rows: 0,
        reviewable_rows: 1,
      },
    },
    attribution: { active_rung: 'snapshot_chain' },
    integrity: [],
    outline: {
      threads: [
        {
          threadKey: 'sec_1',
          order: 1,
          title: 'The change',
          artifact: A,
          checkpoints: [
            {
              checkpointKey: 'chap_1',
              order: 1,
              checkpoint: { artifact: A, cp: 1, label: 'wire the calc' },
              summary: 'wire the calc',
              members: [{ artifact: A, cp: 1 }],
              sliceRefs: [{ hunkKey: 'hunk_1', slice: 0 }],
              citationIds: ['cite:' + A + ':cp1:decision:0'],
            },
          ],
        },
      ],
      unassigned: {
        gap: { sliceRefs: [], files: [] },
        ambiguous: { hunkKeys: [], files: [] },
      },
    },
    plan_coverage: [],
    citations: [
      {
        id: 'cite:' + A + ':cp1:decision:0',
        kind: CITATION_KIND.CHECKPOINT_DECISION,
        artifact: A,
        cp: 1,
        text: 'computed, not hardcoded',
      },
    ],
    landmarks: [],
    disclosure: [],
  };
}

let root: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-comments-test-'));
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedReviewDir(slug: string): Promise<void> {
  const dir = path.join(root, '.orcaops', 'reviews', slug);
  await ensureReviewStateVersion(dir, root);
  await writeFile(path.join(dir, 'floor.json'), JSON.stringify(makeFloor()));
  await writeFile(path.join(dir, 'diff.patch'), DIFF);
}

const commentsArgs = (branch: string): ReviewArgs => ({
  cmd: 'review',
  sub: 'comments',
  branch,
  json: true,
});

const actionArgs = (
  branch: string,
  action: string,
  over: Partial<ReviewArgs> = {}
): ReviewArgs => ({
  cmd: 'review',
  sub: 'comment',
  action,
  branch,
  json: true,
  ...over,
});

function lastPayload(): CommentsPayload {
  return JSON.parse(out[out.length - 1]!) as CommentsPayload;
}

async function makeAnchor() {
  return {
    kind: 'DIFF_LINE' as const,
    file: 'src/a.ts',
    side: 'add' as const,
    line: 2,
    lineHash: await lineHash('add', new TextEncoder().encode(ANCHOR_BODY)),
    hunkKey: 'hunk_1',
    threadKey: 'sec_1',
  };
}

const commentsFile = (slug: string) =>
  path.join(root, '.orcaops', 'reviews', slug, 'comments.ndjson');

describe('review comment — add → reply → resolve round-trip', () => {
  it('refuses a final comments symlink without changing its external target', async () => {
    await seedReviewDir('demo');
    const external = path.join(root, 'external-comments.ndjson');
    await writeFile(external, '');
    await symlink(external, commentsFile('demo'));
    const input = JSON.stringify({ body: 'unsafe append', anchor: await makeAnchor() });

    await expect(runCommentAction(actionArgs('demo', 'add', { input }), root)).rejects.toThrow(
      /symbolic link/u
    );
    await expect(readFile(external, 'utf8')).resolves.toBe('');
  });

  it('adds, enriches (ladder + owner + trail + context), replies with a checkpoint ref, resolves', async () => {
    await seedReviewDir('demo');
    const addInput = JSON.stringify({
      body: 'why 42 and not a config value?',
      anchor: await makeAnchor(),
    });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: addInput }), root)).toBe(0);

    let payload = lastPayload();
    expect(payload.open_count).toBe(1);
    const added = payload.comments[0]!;
    expect(added.author).toBe('reviewer');
    expect(added.status).toBe('open');
    expect(added.position).toMatchObject({
      rung: 'line_hash',
      file: 'src/a.ts',
      line: 2,
      hunkKey: 'hunk_1',
      drifted: false,
    });
    expect(added.owner).toMatchObject({ artifact: A, cp: 1, label: 'wire the calc' });
    expect(added.trail).toEqual([
      {
        id: 'cite:' + A + ':cp1:decision:0',
        kind: CITATION_KIND.CHECKPOINT_DECISION,
        text: 'computed, not hardcoded',
      },
    ]);
    expect(added.context.join('\n')).toContain(`+${ANCHOR_BODY}`);

    // The agent answers under capture and resolves in the same verb call.
    const replyInput = JSON.stringify({
      body: 'moved to config in cp2',
      author: 'agent',
      checkpoint_ref: { artifact: A, cp: 2 },
    });
    expect(
      await runCommentAction(
        actionArgs('demo', 'reply', { id: added.comment_id, input: replyInput, resolve: true }),
        root
      )
    ).toBe(0);

    payload = lastPayload();
    expect(payload.open_count).toBe(0);
    expect(payload.comments[0]).toMatchObject({
      status: 'resolved',
      replies: [
        { author: 'agent', body: 'moved to config in cp2', checkpoint_ref: { artifact: A, cp: 2 } },
      ],
    });

    // Three events on disk: add, reply, status.
    const onDisk = await readFile(commentsFile('demo'), 'utf8');
    expect(onDisk.trim().split('\n')).toHaveLength(3);
  });

  it('resolve (without a reply) flips status under the reviewer author', async () => {
    await seedReviewDir('demo');
    const addInput = JSON.stringify({ body: 'check this', anchor: await makeAnchor() });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: addInput }), root)).toBe(0);
    const id = lastPayload().comments[0]!.comment_id;
    expect(await runCommentAction(actionArgs('demo', 'resolve', { id }), root)).toBe(0);
    expect(lastPayload().comments[0]).toMatchObject({ status: 'resolved' });
    expect(await runCommentAction(actionArgs('demo', 'reopen', { id }), root)).toBe(0);
    expect(lastPayload().comments[0]).toMatchObject({ status: 'open', comment_id: id });
  });

  it('slugifies the branch for the comments path (slash-safe)', async () => {
    await seedReviewDir('demo%2Fx');
    const addInput = JSON.stringify({ body: 'note', anchor: await makeAnchor() });
    expect(await runCommentAction(actionArgs('demo/x', 'add', { input: addInput }), root)).toBe(0);
    await expect(readFile(commentsFile('demo%2Fx'), 'utf8')).resolves.toContain('"note"');
  });

  it('rejects a reply to an unknown comment id with exit 1', async () => {
    await seedReviewDir('demo');
    expect(
      await runCommentAction(
        actionArgs('demo', 'reply', { id: 'nope', input: JSON.stringify({ body: 'x' }) }),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('unknown comment id');
  });

  it('rejects an add with an invalid anchor and writes nothing', async () => {
    await seedReviewDir('demo');
    const bad = JSON.stringify({ body: 'x', anchor: { file: 'src/a.ts' } });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: bad }), root)).toBe(1);
    expect(err.join('')).toContain('invalid anchor');
    await expect(readFile(commentsFile('demo'), 'utf8')).rejects.toThrow();
  });

  it('rejects REVIEW_ITEM for new comments before writing an event', async () => {
    await seedReviewDir('demo');
    const input = JSON.stringify({
      body: 'new item comment',
      anchor: { kind: 'REVIEW_ITEM', itemKey: 'item_1', threadKey: 'sec_1' },
    });
    expect(await runCommentAction(actionArgs('demo', 'add', { input }), root)).toBe(1);
    expect(err.join('')).toContain('invalid anchor');
    await expect(readFile(commentsFile('demo'), 'utf8')).rejects.toThrow();
  });
});

describe('parsePatchHunks — sign column versus file header', () => {
  it('keeps a hunk whose rows render as file headers', () => {
    // `-- ` and `++ ` are comment tokens in SQL, Lua, Haskell, Elm and Ada. Read
    // as headers, the row was dropped AND the rest of the hunk with it, because
    // the header arms clear the current hunk and stop the line counters.
    const diff = [
      'diff --git a/migrate.sql b/migrate.sql',
      '--- a/migrate.sql',
      '+++ b/migrate.sql',
      '@@ -1,3 +1,3 @@',
      ' BEGIN;',
      '--- drop the hardcoded credential',
      '+++ read it from the environment',
      ' COMMIT;',
      '',
    ].join('\n');
    const [hunk] = parsePatchHunks(diff, new Set(['migrate.sql']));
    expect(hunk?.lines.map((line) => [line.side, line.old, line.new])).toEqual([
      ['context', 1, 1],
      ['delete', 2, null],
      ['add', null, 2],
      ['context', 3, 3],
    ]);
  });

  it('reads the next file header as a header once the hunk ends', () => {
    const diff = [
      'diff --git a/a.sql b/a.sql',
      '--- a/a.sql',
      '+++ b/a.sql',
      '@@ -1,1 +1,1 @@',
      '-- first',
      'diff --git a/b.sql b/b.sql',
      '--- a/b.sql',
      '+++ b/b.sql',
      '@@ -1,1 +1,1 @@',
      ' SELECT 2;',
      '',
    ].join('\n');
    const hunks = parsePatchHunks(diff, new Set(['a.sql', 'b.sql']));
    expect(hunks.map((hunk) => hunk.file)).toEqual(['a.sql', 'b.sql']);
    expect(hunks[1]?.lines).toHaveLength(1);
  });
});

describe('review comment — anchor context redaction', () => {
  // A deleted SQL comment renders with three signs, which the diff redactor
  // read as a file header and passed through unscanned. Anchor context is a
  // surface `review comments --json` hands to an agent, so it is a real leak.
  const SECRET_DIFF = [
    'diff --git a/migrate.sql b/migrate.sql',
    'index 0000000..1111111 100644',
    '--- a/migrate.sql',
    '+++ b/migrate.sql',
    '@@ -1,3 +1,3 @@',
    ' BEGIN;',
    '--- api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds',
    '+SELECT 1;',
    ' COMMIT;',
    '',
  ].join('\n');

  it('redacts a credential quoted on a deleted comment row', async () => {
    const floor = makeFloor();
    floor.coverage.items[0]!.file = 'migrate.sql';
    const dir = path.join(root, '.orcaops', 'reviews', 'demo');
    await ensureReviewStateVersion(dir, root);
    await writeFile(path.join(dir, 'floor.json'), JSON.stringify(floor));
    await writeFile(path.join(dir, 'diff.patch'), SECRET_DIFF);

    const input = JSON.stringify({
      body: 'why drop the comment?',
      anchor: {
        kind: 'DIFF_LINE' as const,
        file: 'migrate.sql',
        side: 'add' as const,
        line: 2,
        lineHash: await lineHash('add', new TextEncoder().encode('SELECT 1;')),
        hunkKey: 'hunk_1',
        threadKey: 'sec_1',
      },
    });
    expect(await runCommentAction(actionArgs('demo', 'add', { input }), root)).toBe(0);

    const comment = lastPayload().comments[0]!;
    // The row is a hunk line now, so the anchor resolves rather than drifting.
    expect(comment.position).toMatchObject({ rung: 'line_hash', file: 'migrate.sql', line: 2 });
    const context = comment.context.join('\n');
    expect(context).toContain('--- api_key=');
    expect(context).not.toContain('R7mKq2XvT4bNw9ZcJ5hLp3Ds');
  });
});

describe('review comment — range anchors', () => {
  const RANGE_DIFF = [
    'diff --git a/src/r.ts b/src/r.ts',
    'index 0000000..1111111 100644',
    '--- a/src/r.ts',
    '+++ b/src/r.ts',
    '@@ -1,2 +1,5 @@',
    ' import base from "./base";',
    '+const first = one();',
    '+const second = two();',
    '+const third = three();',
    ' export {};',
    '',
  ].join('\n');

  async function seedRangeReviewDir(slug: string): Promise<void> {
    const floor = makeFloor();
    const item = floor.coverage.items[0]!;
    item.file = 'src/r.ts';
    item.added_lines = 3;
    const dir = path.join(root, '.orcaops', 'reviews', slug);
    await ensureReviewStateVersion(dir, root);
    await writeFile(path.join(dir, 'floor.json'), JSON.stringify(floor));
    await writeFile(path.join(dir, 'diff.patch'), RANGE_DIFF);
  }

  it('a range comment round-trips with endLine on the wire; single-line stays null', async () => {
    await seedRangeReviewDir('demo');
    const enc = new TextEncoder();
    const hashes = await Promise.all(
      ['const first = one();', 'const second = two();', 'const third = three();'].map((body) =>
        lineHash('add', enc.encode(body))
      )
    );
    const anchor = {
      kind: 'DIFF_RANGE' as const,
      file: 'src/r.ts',
      side: 'add' as const,
      line: 2,
      endLine: 4,
      lineHash: hashes[0]!,
      lineHashes: hashes,
      hunkKey: 'hunk_1',
      threadKey: 'sec_1',
    };
    const addInput = JSON.stringify({ body: 'this whole block bothers me', anchor });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: addInput }), root)).toBe(0);

    const ranged = lastPayload().comments[0]!;
    // The wire position carries the resolved span end — what address-comments
    // reads beside its primary position.line.
    expect(ranged.position).toMatchObject({
      rung: 'line_hash',
      file: 'src/r.ts',
      line: 2,
      endLine: 4,
      hunkKey: 'hunk_1',
      drifted: false,
    });
    // And the persisted anchor round-trips the additive keys verbatim.
    expect(ranged.anchor).toMatchObject({ line: 2, endLine: 4, lineHashes: hashes });

    // A single-line comment on the same review emits endLine: null (JSON null,
    // matching the position object's explicit-null convention).
    const singleInput = JSON.stringify({
      body: 'just this line',
      anchor: {
        kind: 'DIFF_LINE',
        file: 'src/r.ts',
        side: 'add',
        line: 3,
        lineHash: hashes[1]!,
        hunkKey: 'hunk_1',
        threadKey: 'sec_1',
      },
    });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: singleInput }), root)).toBe(0);
    const payload = lastPayload();
    const singleLine = payload.comments.find((c) => c.body === 'just this line')!;
    expect(singleLine.position!.endLine).toBeNull();
    expect(out[out.length - 1]).toContain('"endLine":4');
  });

  it('rejects a range add whose lineHashes[0] disagrees with lineHash', async () => {
    await seedRangeReviewDir('demo');
    const bad = JSON.stringify({
      body: 'x',
      anchor: {
        file: 'src/r.ts',
        side: 'add',
        line: 2,
        endLine: 3,
        lineHash: 'lh_primary',
        lineHashes: ['lh_other', 'lh_second'],
      },
    });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: bad }), root)).toBe(1);
    expect(err.join('')).toContain('invalid anchor');
  });
});

describe('review comments — the enriched read', () => {
  it('fails closed on a malformed line and preserves the complete sidecar', async () => {
    await seedReviewDir('demo');
    const addInput = JSON.stringify({ body: 'first', anchor: await makeAnchor() });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: addInput }), root)).toBe(0);
    await appendFile(commentsFile('demo'), 'NOT-JSON{{{\n', 'utf8');
    expect(await runComments(commentsArgs('demo'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!) as object).toMatchObject({
      ok: false,
      health: { kind: 'COMMENTS', status: 'CORRUPT' },
    });
    const preserved = await readFile(commentsFile('demo'), 'utf8');
    expect(preserved).toContain('"body":"first"');
    expect(preserved).toContain('NOT-JSON');
  });

  it('degrades to position:null with a disclosure when no floor is cached', async () => {
    // No seedReviewDir — the add still lands, the read still answers.
    const addInput = JSON.stringify({ body: 'early note', anchor: await makeAnchor() });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: addInput }), root)).toBe(0);
    const payload = lastPayload();
    expect(payload.comments[0]!.position).toBeNull();
    expect(payload.disclosure.join(' ')).toContain('review data');
  });

  it('rejects existing flat anchors instead of inferring a current anchor kind', async () => {
    await seedReviewDir('demo');
    const legacy = {
      type: 'add',
      comment_id: 'legacy-comment',
      ts: '2026-07-12T00:00:00.000Z',
      author: 'reviewer',
      body: 'existing comment',
      anchor: await makeAnchor().then(({ kind: _kind, ...anchor }) => anchor),
    };
    await appendFile(commentsFile('demo'), `${JSON.stringify(legacy)}\n`, 'utf8');
    expect(await runComments(commentsArgs('demo'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!) as object).toMatchObject({
      ok: false,
      health: { kind: 'COMMENTS', status: 'CORRUPT' },
    });
    expect(await readFile(commentsFile('demo'), 'utf8')).toContain('legacy-comment');

    const input = JSON.stringify({ body: 'new legacy-shaped comment', anchor: legacy.anchor });
    expect(await runCommentAction(actionArgs('demo', 'add', { input }), root)).toBe(1);
    expect(err.join('')).toContain('invalid anchor');
  });

  it('rejects a persisted REVIEW_ITEM anchor as corrupt', async () => {
    await seedReviewDir('demo');
    const event = {
      type: 'add',
      comment_id: 'legacy-item-comment',
      ts: '2026-07-12T00:00:00.000Z',
      author: 'reviewer',
      body: 'item-scoped historical comment',
      anchor: { kind: 'REVIEW_ITEM', itemKey: 'retired-item', threadKey: 'sec_1' },
    };
    await writeFile(commentsFile('demo'), `${JSON.stringify(event)}\n`);

    expect(await runComments(commentsArgs('demo'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!) as object).toMatchObject({
      ok: false,
      health: { kind: 'COMMENTS', status: 'CORRUPT' },
    });
    // Fail-closed leaves the log untouched.
    expect(await readFile(commentsFile('demo'), 'utf8')).toContain('legacy-item-comment');
  });

  it('routes unchanged-context comments without diff-line coercion', async () => {
    await seedReviewDir('demo');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const source = 'export const before = 1;\nexport const preserved = 2;\n';
    const blobOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      input: source,
      encoding: 'utf8',
    }).trim();
    const contextInput = JSON.stringify({
      body: 'unchanged contract',
      anchor: {
        kind: 'UNCHANGED_CONTEXT_LINE',
        file: 'src/context.ts',
        headBlobOid: blobOid,
        line: 2,
        lineHash: await contextLineHash('export const preserved = 2;'),
        threadKey: 'sec_1',
      },
    });
    expect(await runCommentAction(actionArgs('demo', 'add', { input: contextInput }), root)).toBe(
      0
    );
    expect(lastPayload().comments[0]!.position).toMatchObject({
      rung: 'unchanged_context',
      file: 'src/context.ts',
      line: 2,
      side: null,
      drifted: false,
    });
    const duplicateBlobInput = JSON.stringify({
      body: 'same blob, different path',
      anchor: {
        kind: 'UNCHANGED_CONTEXT_LINE',
        file: 'src/copied-context.ts',
        headBlobOid: blobOid,
        line: 2,
        lineHash: await contextLineHash('export const preserved = 2;'),
        threadKey: 'sec_1',
      },
    });
    expect(
      await runCommentAction(actionArgs('demo', 'add', { input: duplicateBlobInput }), root)
    ).toBe(0);
    const contextPositions = lastPayload()
      .comments.filter((comment) => comment.position?.rung === 'unchanged_context')
      .map((comment) => comment.position?.file)
      .sort();
    expect(contextPositions).toEqual(['src/context.ts', 'src/copied-context.ts']);
  });
});

describe('review comment — archive mirroring', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let archiveEnv: NodeJS.ProcessEnv;
  const PROJECT_ID = '019f38b7-2222-7000-8000-000000000001';

  const hotComments = (r: string, slug: string) =>
    path.join(r, '.orcaops', 'reviews', slug, 'comments.ndjson');
  const archiveComments = (slug: string) =>
    archiveReviewPaths(archiveProjectDir(dataRoot, PROJECT_ID), REVIEW_STATE_VERSION, slug)
      .commentsNdjson;

  async function enableArchive(): Promise<void> {
    execFileSync('git', ['-C', repo.path, 'config', '--local', 'orcaops.projectid', PROJECT_ID]);
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'config.json'),
      JSON.stringify({ schema_version: 5, archive: { enabled: true } }),
      'utf8'
    );
  }

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-comments-archive-'));
    archiveEnv = {
      ...process.env,
      ORCAOPS_DATA_DIR: dataRoot,
      XDG_CACHE_HOME: path.join(dataRoot, 'xdg-cache'),
    };
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('mirrors add → reply → resolve to the archive byte-identically when enabled', async () => {
    await enableArchive();
    const addInput = JSON.stringify({ body: 'why 42?', anchor: await makeAnchor() });
    expect(
      await runCommentAction(actionArgs('demo', 'add', { input: addInput }), repo.path, archiveEnv)
    ).toBe(0);
    const id = lastPayload().comments[0]!.comment_id;
    const replyInput = JSON.stringify({ body: 'moved to config in cp2', author: 'agent' });
    expect(
      await runCommentAction(
        actionArgs('demo', 'reply', { id, input: replyInput, resolve: true }),
        repo.path,
        archiveEnv
      )
    ).toBe(0);

    // Three events on disk (add, reply, status), archive byte-identical to hot.
    const hot = await readFile(hotComments(repo.path, 'demo'), 'utf8');
    expect(hot.trim().split('\n')).toHaveLength(3);
    expect(await readFile(archiveComments('demo'), 'utf8')).toBe(hot);
  });

  it('keeps the hot write and reports an invalid stored project identity', async () => {
    await enableArchive();
    execFileSync('git', ['-C', repo.path, 'config', '--local', 'orcaops.projectid', 'not-a-uuid']);
    const addInput = JSON.stringify({ body: 'note', anchor: await makeAnchor() });
    expect(
      await runCommentAction(actionArgs('demo', 'add', { input: addInput }), repo.path, archiveEnv)
    ).toBe(0);
    expect(
      (await readFile(hotComments(repo.path, 'demo'), 'utf8')).trim().split('\n')
    ).toHaveLength(1);
    await expect(access(path.join(dataRoot, 'projects', 'not-a-uuid'))).rejects.toThrow();
    expect(err.join('')).toBe('');
    expect(lastPayload().warnings).toEqual([
      {
        code: REVIEW_ARCHIVE_WARNING_CODE.SETUP_FAILED,
        message: expect.stringContaining('not a canonical UUIDv7 project id'),
      },
    ]);
    expect(lastPayload().warnings?.[0]?.message).toContain(
      'git config --local --unset orcaops.projectid'
    );
  });

  it('keeps mirror-write warnings inside the successful JSON response', async () => {
    await enableArchive();
    await writeFile(path.join(dataRoot, 'projects'), 'blocks the archive project directory');
    const addInput = JSON.stringify({ body: 'note', anchor: await makeAnchor() });

    expect(
      await runCommentAction(actionArgs('demo', 'add', { input: addInput }), repo.path, archiveEnv)
    ).toBe(0);

    expect(err.join('')).toBe('');
    expect(lastPayload().warnings).toEqual([
      {
        code: REVIEW_ARCHIVE_WARNING_CODE.WRITE_FAILED,
        message: expect.any(String),
      },
    ]);
    expect(
      (await readFile(hotComments(repo.path, 'demo'), 'utf8')).trim().split('\n')
    ).toHaveLength(1);
  });

  it('writes only the hot log when the archive is disabled', async () => {
    // No enableArchive(): archive.enabled defaults false.
    const addInput = JSON.stringify({ body: 'note', anchor: await makeAnchor() });
    expect(
      await runCommentAction(actionArgs('demo', 'add', { input: addInput }), repo.path, archiveEnv)
    ).toBe(0);
    expect(
      (await readFile(hotComments(repo.path, 'demo'), 'utf8')).trim().split('\n')
    ).toHaveLength(1);
    await expect(access(archiveProjectDir(dataRoot, PROJECT_ID))).rejects.toThrow();
  });

  it('keeps malformed project identity outside the archive path seam', async () => {
    const escapedName = `${path.basename(dataRoot)}-escaped`;
    const escapedRoot = path.resolve(dataRoot, '..', escapedName);
    execFileSync('git', [
      '-C',
      repo.path,
      'config',
      '--local',
      'orcaops.projectid',
      `../${escapedName}`,
    ]);
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'config.json'),
      JSON.stringify({ archive: { enabled: true } }),
      'utf8'
    );

    try {
      const addInput = JSON.stringify({ body: 'note', anchor: await makeAnchor() });
      expect(
        await runCommentAction(
          actionArgs('demo', 'add', { input: addInput }),
          repo.path,
          archiveEnv
        )
      ).toBe(0);
      await expect(access(hotComments(repo.path, 'demo'))).resolves.toBeUndefined();
      await expect(access(escapedRoot)).rejects.toThrow();
    } finally {
      await rm(escapedRoot, { recursive: true, force: true });
    }
  });
});
