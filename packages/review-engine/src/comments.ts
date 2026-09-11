// `review comments` / `review comment …` — the reviewer comment loop.
//
//   review comments --branch <b> [--json]            read + replay + re-anchor
//   review comment add     --branch <b> --input '<json>'          author a comment
//   review comment reply   --branch <b> --id <cid> --input '<json>' [--resolve]
//   review comment resolve --branch <b> --id <cid> [--author <a>]
//
// A comment is a retained identity with append-only revisions
// (`commentEventSchema`). Each write pins the floor and membership it was
// authored against, so the TUI and an agent settle in order rather than
// interleaving. The read path replays the revisions into aggregate records and
// resolves every anchor against the CURRENT floor + diff via the re-anchor
// ladder, emitting everything an agent needs without the TUI: position,
// ±context from the pinned diff, the owning checkpoint, and the adjacent
// captured trail. Missing floor/diff degrades to `position: null` with a
// disclosure. A retained revision that does not decode is an integrity refusal:
// no parsed prefix is replayed and no new revision is appended over it.
//
//   exit 0  records emitted (append, if requested, succeeded)
//   exit 1  usage / precondition error (no branch, bad input, unknown id)

import { randomUUID } from 'node:crypto';

import { redactSecretsInUnifiedDiff } from '@orcaops/evaluator-protocol/secrets';
import {
  type CommentAnchor,
  commentAnchorSchema,
  type CommentEvent,
  commentEventSchema,
  type CommentRecord,
  contextLineHash,
  type CoverageItem,
  type CurrentContextLine,
  type CurrentDiffIndex,
  type CurrentDiffLine,
  type Floor,
  lineHash,
  memberRefSchema,
  openCommentCount,
  reanchorComment,
  type ReanchoredPosition,
  replayComments,
  sliceKey,
} from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';

import { applyDatabaseReviewComments } from './database/comment-command.js';
import { readDatabaseReviewContext } from './database/read-context.js';
import { runGit } from './git.js';
import { parsePatchHunks, type PatchHunk } from './patchHunks.js';
import { writeReviewError, writeReviewOutput } from './reviewFiles.js';
import type { ReviewArgs } from './run.js';

export { parsePatchHunks, type PatchHunk, type PatchHunkLine } from './patchHunks.js';

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

interface CommentOwner {
  artifact: string;
  cp: number;
  label: string | null;
}
interface TrailEntry {
  id: string;
  kind: string;
  text: string;
}
/** The chapter context of one owned slice: its section, checkpoint, and trail. */
interface SliceChapter {
  threadKey: string;
  owner: CommentOwner;
  trail: TrailEntry[];
}

/** Floor lookups: `(file,newStart,oldStart)` → hunkKey, per-hunk units, per-slice chapter. */
interface FloorMaps {
  hunkKeyByPosition: Map<string, string>;
  unitsByHunk: Map<string, CoverageItem['units']>;
  chapterBySlice: Map<string, SliceChapter>;
  hunkKeys: Set<string>;
  files: Set<string>;
  threadKeys: Set<string>;
}

const TRAIL_CAP = 4;

export function positionKey(
  file: string,
  newStart: number | null,
  oldStart: number | null
): string {
  return `${file}\u0000${newStart ?? ''}\u0000${oldStart ?? ''}`;
}

function buildFloorMaps(floor: Floor): FloorMaps {
  const hunkKeyByPosition = new Map<string, string>();
  const unitsByHunk = new Map<string, CoverageItem['units']>();
  const files = new Set<string>();
  for (const item of floor.coverage.items) {
    hunkKeyByPosition.set(
      positionKey(item.file, item.new_start ?? null, item.old_start ?? null),
      item.hunkKey
    );
    unitsByHunk.set(item.hunkKey, item.units);
    files.add(item.file);
  }
  const citationById = new Map(floor.citations.map((c) => [c.id, c]));
  const chapterBySlice = new Map<string, SliceChapter>();
  const threadKeys = new Set<string>();
  for (const section of floor.outline.threads) {
    threadKeys.add(section.threadKey);
    for (const sub of section.checkpoints) {
      const trail = sub.citationIds
        .map((id) => citationById.get(id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
        .slice(0, TRAIL_CAP)
        .map((c) => ({ id: c.id, kind: c.kind, text: c.text }));
      const owner: CommentOwner = {
        artifact: sub.checkpoint.artifact,
        cp: sub.checkpoint.cp,
        label: sub.checkpoint.label ?? null,
      };
      for (const ref of sub.sliceRefs) {
        chapterBySlice.set(sliceKey(ref.hunkKey, ref.slice), {
          threadKey: section.threadKey,
          owner,
          trail,
        });
      }
    }
  }
  return {
    hunkKeyByPosition,
    unitsByHunk,
    chapterBySlice,
    hunkKeys: new Set(hunkKeyByPosition.values()),
    files,
    threadKeys,
  };
}

/**
 * Resolve a re-anchored position to its slice's chapter context. Line grain →
 * the CONTAINING unit (an owned slice yields its chapter's owner/trail; a gap
 * or ambiguous unit yields none — that content lives in Unassigned). Hunk
 * grain (no line survived) → the parent's lowest-ordinal owned slice INSIDE
 * the anchor's surviving section only; a comment is never silently routed
 * into a section its author didn't anchor.
 */
function resolveSliceChapter(
  position: ReanchoredPosition,
  maps: FloorMaps
): { owner: CommentOwner | null; trail: TrailEntry[] } {
  const none = { owner: null, trail: [] };
  if (position.hunkKey === null) return none;
  const units = maps.unitsByHunk.get(position.hunkKey) ?? [];

  if (position.line !== null) {
    for (const unit of units) {
      if (unit.kind === 'ambiguous_hunk') return none;
      const range = position.side === 'add' ? unit.add_range : unit.del_range;
      if (range === null || position.line < range.start || position.line > range.end) continue;
      if (unit.kind !== 'owned_slice') return none;
      const chapter = maps.chapterBySlice.get(sliceKey(position.hunkKey, unit.slice));
      return chapter ? { owner: chapter.owner, trail: chapter.trail } : none;
    }
    return none;
  }

  if (position.threadKey === null) return none;
  for (const unit of units) {
    if (unit.kind !== 'owned_slice') continue;
    const chapter = maps.chapterBySlice.get(sliceKey(position.hunkKey, unit.slice));
    if (chapter !== undefined && chapter.threadKey === position.threadKey) {
      return { owner: chapter.owner, trail: chapter.trail };
    }
  }
  return none;
}

const encoder = new TextEncoder();

/** Hash the changed lines of the anchored files with the manifest line-hash recipe. */
async function buildDiffIndex(
  hunks: readonly PatchHunk[],
  maps: FloorMaps,
  contextLines: readonly CurrentContextLine[] = []
): Promise<{ index: CurrentDiffIndex; hunkByKey: Map<string, PatchHunk> }> {
  const lines: CurrentDiffLine[] = [];
  const hunkByKey = new Map<string, PatchHunk>();
  for (const hunk of hunks) {
    const hunkKey =
      maps.hunkKeyByPosition.get(positionKey(hunk.file, hunk.newStart, hunk.oldStart)) ??
      maps.hunkKeyByPosition.get(positionKey(hunk.file, hunk.newStart, null)) ??
      null;
    if (hunkKey !== null && !hunkByKey.has(hunkKey)) hunkByKey.set(hunkKey, hunk);
    for (const line of hunk.lines) {
      if (line.side === 'context') continue;
      lines.push({
        file: hunk.file,
        side: line.side,
        line: (line.side === 'add' ? line.new : line.old) ?? 0,
        lineHash: await lineHash(line.side, encoder.encode(line.body)),
        hunkKey,
      });
    }
  }
  return {
    index: {
      lines,
      hunkKeys: maps.hunkKeys,
      files: maps.files,
      threadKeys: maps.threadKeys,
      contextLines,
    },
    hunkByKey,
  };
}

async function buildContextLines(
  records: readonly CommentRecord[],
  root: string
): Promise<CurrentContextLine[]> {
  const anchors = records
    .map((record) => record.anchor)
    .filter((anchor) => anchor.kind === 'UNCHANGED_CONTEXT_LINE');
  const byFileAndBlob = new Map<string, { file: string; headBlobOid: string }>();
  for (const anchor of anchors) {
    byFileAndBlob.set(`${anchor.file}\u0000${anchor.headBlobOid}`, {
      file: anchor.file,
      headBlobOid: anchor.headBlobOid,
    });
  }
  const out: CurrentContextLine[] = [];
  for (const { headBlobOid, file } of byFileAndBlob.values()) {
    const blob = await runGit(root, ['cat-file', '-p', headBlobOid]);
    if (blob.code !== 0) continue;
    const lines = blob.stdout.toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      out.push({
        file,
        headBlobOid,
        line: index + 1,
        lineHash: await contextLineHash(lines[index]!),
      });
    }
  }
  return out;
}

const CONTEXT_RADIUS = 2;
const HUNK_CONTEXT_LINES = 3;

/**
 * Anchor context is raw diff rows, and `review comments --json` is a surface an
 * agent reads. Each row goes through the diff redactor rather than the plain
 * one so the sign column survives — these are displayed against line numbers.
 * The hashes reviewer identity is keyed on come from the HEAD blob, not from
 * these strings, so redacting here moves no key.
 */
function redactContext(lines: string[]): string[] {
  // `hunkBody` because these arrive one row at a time with no `@@` in front of
  // them: read as a preamble, a `-- api_key=…` row renders as `--- ` and is
  // passed through as a file header.
  return lines.map((line) => redactSecretsInUnifiedDiff(line, { hunkBody: true }));
}

/** ±context raw diff lines around a resolved position (hunk-grain → the hunk head). */
function contextFor(pos: ReanchoredPosition, hunkByKey: Map<string, PatchHunk>): string[] {
  if (pos.hunkKey === null) return [];
  const hunk = hunkByKey.get(pos.hunkKey);
  if (!hunk) return [];
  if (pos.line !== null) {
    const at = hunk.lines.findIndex((l) =>
      pos.side === 'add' ? l.new === pos.line && l.side !== 'delete' : l.old === pos.line
    );
    if (at !== -1) {
      return redactContext(
        hunk.lines
          .slice(Math.max(0, at - CONTEXT_RADIUS), at + CONTEXT_RADIUS + 1)
          .map((l) => l.raw)
      );
    }
  }
  return redactContext(hunk.lines.slice(0, HUNK_CONTEXT_LINES).map((l) => l.raw));
}

// ---------------------------------------------------------------------------
// The enriched read — what `review comments --json` emits
// ---------------------------------------------------------------------------

export interface EnrichedComment extends CommentRecord {
  /** Re-anchored position, or null when no floor/diff is cached yet. */
  position: ReanchoredPosition | null;
  /** ±context raw diff lines from the pinned diff around the position. */
  context: string[];
  /** The owning checkpoint of the resolved hunk, when attribution knows one. */
  owner: { artifact: string; cp: number; label: string | null } | null;
  /** Adjacent captured trail (decisions/uncertainties cited by the owning chapter). */
  trail: { id: string; kind: string; text: string }[];
}

export interface CommentsPayload {
  schema_version: 1;
  branch: string;
  open_count: number;
  disclosure: string[];
  comments: EnrichedComment[];
}

async function assemblePayload(branch: string, root: string): Promise<CommentsPayload> {
  const context = await readDatabaseReviewContext({ branch, cwd: root });
  const records = replayComments(
    context.comments.comments.flatMap((comment) =>
      comment.revisions.map((revision) => revision.event)
    )
  );
  const disclosure: string[] = [];

  if (context.floor === null) {
    if (records.length > 0) {
      disclosure.push(
        'no selected floor for this review — run `review data` for anchored positions'
      );
    }
    return {
      schema_version: 1,
      branch,
      open_count: openCommentCount(records),
      disclosure,
      comments: records.map((r) => ({ ...r, position: null, context: [], owner: null, trail: [] })),
    };
  }
  const floor = context.floor.floor as Floor;
  const diffText = Buffer.from(context.floor.diffBytes).toString('utf8');

  const maps = buildFloorMaps(floor);
  const anchorFiles = new Set(
    records
      .map((record) => record.anchor)
      .filter((anchor) => anchor.kind === 'DIFF_LINE' || anchor.kind === 'DIFF_RANGE')
      .map((anchor) => anchor.file)
  );
  const contextLines = await buildContextLines(records, root);
  const { index, hunkByKey } = await buildDiffIndex(
    parsePatchHunks(diffText, anchorFiles),
    maps,
    contextLines
  );

  const comments: EnrichedComment[] = records.map((r) => {
    const position = reanchorComment(r.anchor, index);
    const chapter = resolveSliceChapter(position, maps);
    return {
      ...r,
      position,
      context: contextFor(position, hunkByKey),
      owner: chapter.owner,
      trail: chapter.trail,
    };
  });

  return {
    schema_version: 1,
    branch,
    open_count: openCommentCount(records),
    disclosure,
    comments,
  };
}

function emitPayload(payload: CommentsPayload, json: boolean): void {
  if (json) {
    writeReviewOutput(`${JSON.stringify(payload)}\n`);
    return;
  }
  writeReviewOutput(
    `comments: ${payload.branch} · ${payload.comments.length} comment(s) · ${payload.open_count} open\n`
  );
  for (const c of payload.comments) {
    // Range anchors carry endLine (`file:10-14`); single-line stays `file:10`.
    const at =
      c.position === null
        ? 'unresolved'
        : c.position.line !== null
          ? `${c.position.file}:${c.position.line}${
              c.position.endLine !== null ? `-${c.position.endLine}` : ''
            }`
          : (c.position.file ?? c.position.rung);
    const drift = c.position?.drifted === true ? ' · anchor drifted' : '';
    writeReviewOutput(`  ✎ [${c.status}] ${at}${drift} — ${c.body.split('\n')[0]}\n`);
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/** Run `review comments` (the enriched read). Returns the process exit code. */
export async function runComments(args: ReviewArgs, root: string): Promise<number> {
  if (!args.branch) {
    writeReviewError('review comments: --branch <branch> is required\n');
    return 1;
  }
  try {
    emitPayload(await assemblePayload(args.branch, root), args.json);
    return 0;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (args.json)
      writeReviewOutput(
        `${JSON.stringify({
          ok: false,
          error: { code: failure.code ?? 'HISTORY_INACCESSIBLE', message: failure.message },
        })}\n`
      );
    else writeReviewError(`review comments: ${failure.message ?? String(error)}\n`);
    return 1;
  }
}

interface ParsedInput {
  body?: unknown;
  author?: unknown;
  anchor?: unknown;
  checkpoint_ref?: unknown;
}

function parseInput(raw: string | undefined, verb: string): ParsedInput | null {
  if (raw === undefined) {
    writeReviewError(`review comment ${verb}: --input '<json>' is required\n`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeReviewError(`review comment ${verb}: --input must be a JSON object\n`);
      return null;
    }
    return parsed as ParsedInput;
  } catch {
    writeReviewError(`review comment ${verb}: --input is not valid JSON\n`);
    return null;
  }
}

function coerceAuthor(raw: unknown, fallback: 'reviewer' | 'agent'): 'reviewer' | 'agent' | null {
  if (raw === undefined) return fallback;
  if (raw === 'reviewer' || raw === 'agent') return raw;
  writeReviewError(`review comment: author must be 'reviewer' or 'agent'\n`);
  return null;
}

function coerceBody(raw: unknown, verb: string): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  writeReviewError(`review comment ${verb}: a non-empty body is required\n`);
  return null;
}

/** Validate the authored batch, settle it in the store, then emit the fresh payload. */
async function appendAndEmit(args: ReviewArgs, events: unknown[], root: string): Promise<number> {
  const parsed: CommentEvent[] = [];
  for (const event of events) {
    const result = commentEventSchema.safeParse(event);
    if (!result.success) {
      writeReviewError(`review comment: invalid event (${issues(result.error)})\n`);
      return 1;
    }
    parsed.push(result.data);
  }
  try {
    await applyDatabaseReviewComments({
      branch: args.branch!,
      cwd: root,
      operationId: args.operationId ?? uuidv7(),
      events: parsed,
      secretAllow: [],
    });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (args.json)
      writeReviewOutput(
        `${JSON.stringify({
          ok: false,
          error: { code: failure.code ?? 'HISTORY_INACCESSIBLE', message: failure.message },
        })}\n`
      );
    else writeReviewError(`review comment: ${failure.message ?? String(error)}\n`);
    return 1;
  }
  emitPayload(await assemblePayload(args.branch!, root), args.json);
  return 0;
}

/** Run `review comment add|reply|resolve|reopen`. Returns the process exit code. */
export async function runCommentAction(args: ReviewArgs, root: string): Promise<number> {
  if (!args.branch) {
    writeReviewError('review comment: --branch <branch> is required\n');
    return 1;
  }
  const now = new Date().toISOString();

  if (args.action === 'add') {
    const input = parseInput(args.input, 'add');
    if (input === null) return 1;
    const author = coerceAuthor(input.author, 'reviewer');
    const body = coerceBody(input.body, 'add');
    const anchorResult = commentAnchorSchema.safeParse(input.anchor);
    if (author === null || body === null) return 1;
    if (!anchorResult.success) {
      writeReviewError(`review comment add: invalid anchor (${issues(anchorResult.error)})\n`);
      return 1;
    }
    const anchor: CommentAnchor = anchorResult.data;
    return appendAndEmit(
      args,
      [{ type: 'add', comment_id: randomUUID(), ts: now, author, body, anchor }],
      root
    );
  }

  if (args.action === 'reply' || args.action === 'resolve' || args.action === 'reopen') {
    if (args.id === undefined || args.id.length === 0) {
      writeReviewError(`review comment ${args.action}: --id <comment_id> is required\n`);
      return 1;
    }
    const existing = (await assemblePayload(args.branch, root)).comments;
    if (!existing.some((r) => r.comment_id === args.id)) {
      writeReviewError(`review comment ${args.action}: unknown comment id '${args.id}'\n`);
      return 1;
    }

    if (args.action === 'resolve' || args.action === 'reopen') {
      const author = coerceAuthor(args.author, 'reviewer');
      if (author === null) return 1;
      return appendAndEmit(
        args,
        [
          {
            type: 'status',
            comment_id: args.id,
            ts: now,
            author,
            status: args.action === 'resolve' ? 'resolved' : 'open',
          },
        ],
        root
      );
    }

    const input = parseInput(args.input, 'reply');
    if (input === null) return 1;
    const author = coerceAuthor(input.author, 'reviewer');
    const body = coerceBody(input.body, 'reply');
    if (author === null || body === null) return 1;
    let checkpointRef: { artifact: string; cp: number } | undefined;
    if (input.checkpoint_ref !== undefined) {
      const refResult = memberRefSchema.safeParse(input.checkpoint_ref);
      if (!refResult.success) {
        writeReviewError(
          `review comment reply: invalid checkpoint_ref (${issues(refResult.error)})\n`
        );
        return 1;
      }
      checkpointRef = refResult.data;
    }
    const events: unknown[] = [
      {
        type: 'reply',
        comment_id: args.id,
        ts: now,
        author,
        body,
        ...(checkpointRef !== undefined ? { checkpoint_ref: checkpointRef } : {}),
      },
    ];
    if (args.resolve === true) {
      events.push({ type: 'status', comment_id: args.id, ts: now, author, status: 'resolved' });
    }
    return appendAndEmit(args, events, root);
  }

  writeReviewError(`review comment: unknown action '${args.action ?? ''}'\n`);
  return 2;
}
