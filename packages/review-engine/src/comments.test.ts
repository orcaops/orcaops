// Headless round-trip for the comment verbs: add → reply → resolve against the
// review's selected floor and its retained diff (the re-anchor ladder, owner,
// trail and ±context all come back on the enriched read), plus unknown-id and
// anchor-shape refusals. Comments are retained rows, so nothing here reads a
// comments log.

import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CITATION_KIND, contextLineHash, type Floor, lineHash } from '@orcaops/review-core';

import type { CommentsPayload } from './comments.js';
import { parsePatchHunks, runCommentAction, runComments } from './comments.js';
import type { ReviewArgs } from './run.js';
import {
  capturedReviewFixture,
  type CapturedReviewFixture,
} from '../tests/capturedReviewFixture.js';

const ANCHOR_BODY = 'const answer = compute(42);';
const DELETED_SQL_COMMENT = '--- drop the hardcoded credential';
const CONTEXT_SOURCE = 'export const before = 1;\nexport const preserved = 2;\n';

const BASE_FILES = {
  '.gitignore': '.orcaops/\n',
  'src/a.ts': 'import { compute } from "./calc";\nexport function main() {}\n',
  'migrate.sql': `BEGIN;\n${DELETED_SQL_COMMENT}\nCOMMIT;\n`,
  'src/r.ts': 'import base from "./base";\nexport {};\n',
  'src/context.ts': CONTEXT_SOURCE,
  'src/copied-context.ts': CONTEXT_SOURCE,
};

const CHANGED_FILES = {
  'src/a.ts': `import { compute } from "./calc";\n${ANCHOR_BODY}\nexport function main() {}\n`,
  'migrate.sql': 'BEGIN;\nSELECT 1;\nCOMMIT;\n',
  'src/r.ts':
    'import base from "./base";\nconst first = one();\nconst second = two();\nconst third = three();\nexport {};\n',
};

let fixture: CapturedReviewFixture;
let floor: Floor;
let threadKey: string;
let out: string[];
let err: string[];

const hunkFor = (file: string): string => {
  const item = floor.coverage.items.find((entry) => entry.file === file);
  expect(item, `the published floor covers ${file}`).toBeDefined();
  return item!.hunkKey;
};

beforeAll(async () => {
  fixture = await capturedReviewFixture({
    autoCleanup: false,
    baseFiles: BASE_FILES,
    artifacts: [
      {
        label: 'wire the calc',
        task: 'compute the answer instead of hard-coding it',
        checkpoints: [
          {
            summary: 'wire the calc',
            changes: CHANGED_FILES,
            completedSteps: [0],
            decisions: [
              {
                decision: 'computed, not hardcoded',
                reason: 'a literal drifts away from the config it duplicates',
              },
            ],
          },
        ],
      },
    ],
  });
  floor = (await fixture.publishFloor()).floor;
  threadKey = floor.outline.threads[0]!.threadKey;
}, 300_000);

afterAll(async () => {
  await fixture.cleanup();
});

beforeEach(() => {
  vi.stubEnv('ORCAOPS_DATA_DIR', fixture.dataRoot);
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const commentsArgs = (): ReviewArgs => ({
  cmd: 'review',
  sub: 'comments',
  branch: fixture.branch,
  json: true,
});

const actionArgs = (action: string, over: Partial<ReviewArgs> = {}): ReviewArgs => ({
  cmd: 'review',
  sub: 'comment',
  action,
  branch: fixture.branch,
  json: true,
  ...over,
});

const act = (action: string, over: Partial<ReviewArgs> = {}) =>
  runCommentAction(actionArgs(action, over), fixture.gitRoot);

function lastPayload(): CommentsPayload {
  return JSON.parse(out[out.length - 1]!) as CommentsPayload;
}

const found = (body: string) => {
  const comment = lastPayload().comments.find((entry) => entry.body === body);
  expect(comment, `the payload carries the comment "${body}"`).toBeDefined();
  return comment!;
};

async function anchorOn(file: string, line: number, body: string) {
  return {
    kind: 'DIFF_LINE' as const,
    file,
    side: 'add' as const,
    line,
    lineHash: await lineHash('add', new TextEncoder().encode(body)),
    hunkKey: hunkFor(file),
    threadKey,
  };
}

describe('review comment — add → reply → resolve round-trip', () => {
  it('adds, enriches (ladder + owner + trail + context), replies with a checkpoint ref, resolves', async () => {
    const body = 'why 42 and not a config value?';
    expect(
      await act('add', {
        input: JSON.stringify({ body, anchor: await anchorOn('src/a.ts', 2, ANCHOR_BODY) }),
      })
    ).toBe(0);

    const added = found(body);
    expect(added.author).toBe('reviewer');
    expect(added.status).toBe('open');
    expect(added.position).toMatchObject({
      rung: 'line_hash',
      file: 'src/a.ts',
      line: 2,
      hunkKey: hunkFor('src/a.ts'),
      drifted: false,
    });
    const artifactId = fixture.artifacts[0]!.artifactId;
    expect(added.owner).toMatchObject({ artifact: artifactId, cp: 1, label: 'wire the calc' });
    expect(added.trail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: CITATION_KIND.CHECKPOINT_DECISION,
          text: expect.stringContaining('computed, not hardcoded'),
        }),
      ])
    );
    expect(added.context.join('\n')).toContain(`+${ANCHOR_BODY}`);

    // The agent answers under capture and resolves in the same verb call.
    expect(
      await act('reply', {
        id: added.comment_id,
        resolve: true,
        input: JSON.stringify({
          body: 'moved to config in cp2',
          author: 'agent',
          checkpoint_ref: { artifact: artifactId, cp: 1 },
        }),
      })
    ).toBe(0);
    expect(found(body)).toMatchObject({
      status: 'resolved',
      replies: [
        {
          author: 'agent',
          body: 'moved to config in cp2',
          checkpoint_ref: { artifact: artifactId, cp: 1 },
        },
      ],
    });

    // Three retained revisions on the author's original comment identity: add,
    // reply, status.
    const revisions = await fixture.read((database) =>
      database.read((view) =>
        view.all<{ revision_id: string }>(
          'SELECT revision_id FROM review_comment_revisions WHERE comment_id = ?',
          added.comment_id
        )
      )
    );
    expect(revisions.value).toHaveLength(3);
  }, 300_000);

  it('resolve (without a reply) flips status under the reviewer author', async () => {
    const body = 'check this';
    expect(
      await act('add', {
        input: JSON.stringify({ body, anchor: await anchorOn('src/a.ts', 2, ANCHOR_BODY) }),
      })
    ).toBe(0);
    const id = found(body).comment_id;
    expect(await act('resolve', { id })).toBe(0);
    expect(found(body)).toMatchObject({ status: 'resolved' });
    expect(await act('reopen', { id })).toBe(0);
    expect(found(body)).toMatchObject({ status: 'open', comment_id: id });
  }, 180_000);

  it('rejects a reply to an unknown comment id with exit 1', async () => {
    expect(await act('reply', { id: 'nope', input: JSON.stringify({ body: 'x' }) })).toBe(1);
    expect(err.join('')).toContain('unknown comment id');
  }, 120_000);

  it('rejects an add with an invalid anchor and retains nothing', async () => {
    const before = await fixture.read((database) =>
      database.read((view) => view.all('SELECT comment_id FROM review_comments'))
    );
    expect(
      await act('add', { input: JSON.stringify({ body: 'x', anchor: { file: 'src/a.ts' } }) })
    ).toBe(1);
    expect(err.join('')).toContain('invalid anchor');
    const after = await fixture.read((database) =>
      database.read((view) => view.all('SELECT comment_id FROM review_comments'))
    );
    expect(after.value).toEqual(before.value);
  }, 120_000);

  it('rejects REVIEW_ITEM for new comments before retaining an event', async () => {
    expect(
      await act('add', {
        input: JSON.stringify({
          body: 'new item comment',
          anchor: { kind: 'REVIEW_ITEM', itemKey: 'item_1', threadKey },
        }),
      })
    ).toBe(1);
    expect(err.join('')).toContain('invalid anchor');
  }, 120_000);

  it('anchors beside a deleted three-sign row without reading it as a file header', async () => {
    // `--- ` is a comment token in SQL, Lua, Haskell, Elm and Ada. Read as a
    // header, the deleted row was dropped and the rest of the hunk with it, so
    // the ±context a reviewer sees lost the line the comment is about.
    const body = 'why drop the comment?';
    expect(
      await act('add', {
        input: JSON.stringify({
          body,
          anchor: await anchorOn('migrate.sql', 2, 'SELECT 1;'),
        }),
      })
    ).toBe(0);
    const comment = found(body);
    // The row is a hunk line now, so the anchor resolves rather than drifting.
    expect(comment.position).toMatchObject({ rung: 'line_hash', file: 'migrate.sql', line: 2 });
    expect(comment.context.join('\n')).toContain(DELETED_SQL_COMMENT);
  }, 180_000);

  it('never retains a floor whose diff quotes a credential', async () => {
    // The store refuses the publication itself, so a recognized credential
    // never reaches a retained floor for a comment to be anchored beside. This
    // is where the old per-payload redaction moved: earlier, and fail-closed.
    const leaking = await capturedReviewFixture({
      baseFiles: { '.gitignore': '.orcaops/\n', 'src/deploy.ts': 'export const key = null;\n' },
      artifacts: [
        {
          label: 'Wire the deploy key',
          task: 'Read the deploy key at start-up',
          checkpoints: [
            {
              summary: 'Read the deploy key at start-up.',
              changes: {
                'src/deploy.ts': `const apiKey = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';\n`,
              },
              completedSteps: [0],
            },
          ],
        },
      ],
    });
    try {
      await expect(leaking.publishFloor()).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    } finally {
      await leaking.cleanup();
    }
  }, 180_000);
});

describe('review comment — range anchors', () => {
  it('a range comment round-trips with endLine on the wire; single-line stays null', async () => {
    const enc = new TextEncoder();
    const hashes = await Promise.all(
      ['const first = one();', 'const second = two();', 'const third = three();'].map((line) =>
        lineHash('add', enc.encode(line))
      )
    );
    const rangeBody = 'this whole block bothers me';
    expect(
      await act('add', {
        input: JSON.stringify({
          body: rangeBody,
          anchor: {
            kind: 'DIFF_RANGE' as const,
            file: 'src/r.ts',
            side: 'add' as const,
            line: 2,
            endLine: 4,
            lineHash: hashes[0]!,
            lineHashes: hashes,
            hunkKey: hunkFor('src/r.ts'),
            threadKey,
          },
        }),
      })
    ).toBe(0);

    const ranged = found(rangeBody);
    // The wire position carries the resolved span end — what address-comments
    // reads beside its primary position.line.
    expect(ranged.position).toMatchObject({
      rung: 'line_hash',
      file: 'src/r.ts',
      line: 2,
      endLine: 4,
      hunkKey: hunkFor('src/r.ts'),
      drifted: false,
    });
    // And the retained anchor round-trips the additive keys verbatim.
    expect(ranged.anchor).toMatchObject({ line: 2, endLine: 4, lineHashes: hashes });

    // A single-line comment on the same review emits endLine: null (JSON null,
    // matching the position object's explicit-null convention).
    const singleBody = 'just this line';
    expect(
      await act('add', {
        input: JSON.stringify({
          body: singleBody,
          anchor: {
            kind: 'DIFF_LINE',
            file: 'src/r.ts',
            side: 'add',
            line: 3,
            lineHash: hashes[1]!,
            hunkKey: hunkFor('src/r.ts'),
            threadKey,
          },
        }),
      })
    ).toBe(0);
    expect(found(singleBody).position!.endLine).toBeNull();
    expect(out[out.length - 1]).toContain('"endLine":4');
  }, 300_000);

  it('rejects a range add whose lineHashes[0] disagrees with lineHash', async () => {
    expect(
      await act('add', {
        input: JSON.stringify({
          body: 'x',
          anchor: {
            file: 'src/r.ts',
            side: 'add',
            line: 2,
            endLine: 3,
            lineHash: 'lh_primary',
            lineHashes: ['lh_other', 'lh_second'],
          },
        }),
      })
    ).toBe(1);
    expect(err.join('')).toContain('invalid anchor');
  }, 120_000);
});

describe('review comments — the enriched read', () => {
  it('routes unchanged-context comments without diff-line coercion', async () => {
    // The anchor must name a file the retained floor's pinned tree carries with
    // exactly this blob, so both paths are tracked and unchanged by the capture.
    const blobOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: fixture.gitRoot,
      input: CONTEXT_SOURCE,
      encoding: 'utf8',
    }).trim();
    const contextAnchor = (file: string) => ({
      kind: 'UNCHANGED_CONTEXT_LINE',
      file,
      headBlobOid: blobOid,
      line: 2,
      lineHash: null as string | null,
      threadKey,
    });
    const hash = await contextLineHash('export const preserved = 2;');
    expect(
      await act('add', {
        input: JSON.stringify({
          body: 'unchanged contract',
          anchor: { ...contextAnchor('src/context.ts'), lineHash: hash },
        }),
      })
    ).toBe(0);
    expect(found('unchanged contract').position).toMatchObject({
      rung: 'unchanged_context',
      file: 'src/context.ts',
      line: 2,
      side: null,
      drifted: false,
    });
    expect(
      await act('add', {
        input: JSON.stringify({
          body: 'same blob, different path',
          anchor: { ...contextAnchor('src/copied-context.ts'), lineHash: hash },
        }),
      })
    ).toBe(0);
    const contextPositions = lastPayload()
      .comments.filter((comment) => comment.position?.rung === 'unchanged_context')
      .map((comment) => comment.position?.file)
      .sort();
    expect(contextPositions).toEqual(['src/context.ts', 'src/copied-context.ts']);
  }, 300_000);

  it('reads back every retained comment without a log', async () => {
    expect(await runComments(commentsArgs(), fixture.gitRoot)).toBe(0);
    const payload = lastPayload();
    expect(payload.branch).toBe(fixture.branch);
    expect(payload.comments.length).toBeGreaterThan(0);
    expect(payload.disclosure).toEqual([]);
  }, 120_000);
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
