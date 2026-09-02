// `review comments` / `review comment …` — the reviewer comment loop.
//
//   review comments --branch <b> [--json]            read + replay + re-anchor
//   review comment add     --branch <b> --input '<json>'          author a comment
//   review comment reply   --branch <b> --id <cid> --input '<json>' [--resolve]
//   review comment resolve --branch <b> --id <cid> [--author <a>]
//
// The log is `.orcaops/reviews/<slug>/comments.ndjson`, one event per line
// (`commentEventSchema`). Writes go through the same per-slug ArtifactLock as
// the journal, so the TUI and an agent never interleave a line. The read path
// replays the log into aggregate records and resolves every anchor against the
// CURRENT floor + diff via the re-anchor ladder, emitting everything an agent
// needs without the TUI: position, ±context from the pinned diff, the owning
// checkpoint, and the adjacent captured trail. Missing floor/diff degrades to
// `position: null` with a disclosure. A malformed sidecar fails closed: no
// parsed prefix is replayed and no new event is appended over it.
//
//   exit 0  records emitted (append, if requested, succeeded)
//   exit 1  usage / precondition error (no branch, bad input, unknown id)

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { redactSecretsInUnifiedDiff } from '@orcaops/evaluator-protocol/secrets';
import {
  type CommentAnchor,
  commentAnchorSchema,
  commentEventSchema,
  type CommentRecord,
  contextLineHash,
  type CoverageItem,
  type CurrentContextLine,
  type CurrentDiffIndex,
  type CurrentDiffLine,
  type Floor,
  floorSchema,
  lineHash,
  memberRefSchema,
  openCommentCount,
  reanchorComment,
  type ReanchoredPosition,
  replayComments,
  sliceKey,
  slugifyBranch,
} from '@orcaops/review-core';
import { appendDurable, reviewEventIdentity } from '@orcaops/storage';

import { reviewArchiveMirror, type ReviewArchiveWarning } from './archive.js';
import { DurableStateReadError, readCommentEventsStrict } from './durableState.js';
import { runGit } from './git.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath, reviewEntryPath } from './reviewPaths.js';
import {
  ensureReviewStateVersion,
  REVIEW_STATE_VERSION,
  ReviewStateHealthError,
  reviewStateLockKey,
} from './reviewState.js';
import type { ReviewArgs } from './run.js';

interface CommentPaths {
  slug: string;
  dir: string;
  file: string;
  floorFile: string;
  diffFile: string;
  locksDir: string;
}

function commentPaths(root: string, branch: string): CommentPaths {
  const slug = slugifyBranch(branch);
  const dir = reviewDirPath(root, slug);
  return {
    slug,
    dir,
    file: path.join(dir, 'comments.ndjson'),
    floorFile: path.join(dir, 'floor.json'),
    diffFile: path.join(dir, 'diff.patch'),
    locksDir: path.join(root, '.orcaops', 'tmp', 'locks'),
  };
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

// ---------------------------------------------------------------------------
// Current-diff enrichment — parse the pinned diff, hash the anchored files
// ---------------------------------------------------------------------------

export interface PatchHunkLine {
  side: 'add' | 'delete' | 'context';
  /** Old-file line number (deletes + context). */
  old: number | null;
  /** New-file line number (adds + context). */
  new: number | null;
  /** The raw diff line, sign included. */
  raw: string;
  /** The line body without the sign. */
  body: string;
}

export interface PatchHunk {
  file: string;
  oldStart: number;
  newStart: number;
  lines: PatchHunkLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse the pinned unified diff into per-hunk lines, keeping only `files`. */
export function parsePatchHunks(text: string, files: ReadonlySet<string>): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let fileBefore: string | null = null;
  let fileAfter: string | null = null;
  let current: PatchHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  // Inside a hunk every row carries a sign column, so the file-header prefixes
  // describe the SIGNED row rather than its content: a deleted `-- ` line
  // renders as `--- ` and an added `++ ` line as `+++ `. Reading those as
  // headers dropped the row AND everything after it in the same hunk, since the
  // header arms also clear `current` and stop the line counters — so one SQL or
  // Lua comment silently truncated a file's attribution.
  let inHunk = false;

  for (const raw of text.split('\n')) {
    if (inHunk && !continuesHunkBody(raw)) inHunk = false;
    if (!inHunk) {
      if (raw.startsWith('diff --git')) {
        fileBefore = null;
        fileAfter = null;
        current = null;
        continue;
      }
      if (raw.startsWith('--- ')) {
        fileBefore = stripPrefix(raw.slice(4).trim());
        current = null;
        continue;
      }
      if (raw.startsWith('+++ ')) {
        fileAfter = stripPrefix(raw.slice(4).trim());
        current = null;
        continue;
      }
      const header = HUNK_RE.exec(raw);
      if (header === null) {
        current = null;
        continue;
      }
      const file = fileAfter ?? fileBefore;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      if (file !== null && files.has(file)) {
        current = { file, oldStart: oldLine, newStart: newLine, lines: [] };
        hunks.push(current);
      } else {
        current = null;
      }
      continue;
    }
    const kind = raw[0];
    if (kind === '+') {
      current?.lines.push({ side: 'add', old: null, new: newLine, raw, body: raw.slice(1) });
      newLine += 1;
    } else if (kind === '-') {
      current?.lines.push({ side: 'delete', old: oldLine, new: null, raw, body: raw.slice(1) });
      oldLine += 1;
    } else if (kind === ' ') {
      current?.lines.push({ side: 'context', old: oldLine, new: newLine, raw, body: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
    // `\` annotates the row before it and is the only other body line.
  }
  return hunks;
}

/**
 * True while `raw` still belongs to the hunk body that precedes it. Git renders
 * an empty context line as a single space, so a bare newline ends the hunk.
 */
function continuesHunkBody(raw: string): boolean {
  const sign = raw.charAt(0);
  return sign === ' ' || sign === '+' || sign === '-' || sign === '\\';
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
  warnings?: ReviewArchiveWarning[];
}

async function assemblePayload(
  branch: string,
  paths: CommentPaths,
  root: string
): Promise<CommentsPayload> {
  const records = replayComments(await readCommentEventsStrict(paths.file));
  const disclosure: string[] = [];

  let floor: Floor | null = null;
  try {
    floor = floorSchema.parse(JSON.parse(await readFile(paths.floorFile, 'utf8')));
  } catch {
    floor = null;
  }
  let diffText: string | null = null;
  try {
    diffText = await readFile(paths.diffFile, 'utf8');
  } catch {
    diffText = null;
  }
  if (floor === null || diffText === null) {
    if (records.length > 0) {
      disclosure.push(
        `floor or diff not cached under ${path.dirname(paths.floorFile)} — run \`review data\` for anchored positions`
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
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(
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
    process.stdout.write(`  ✎ [${c.status}] ${at}${drift} — ${c.body.split('\n')[0]}\n`);
  }
  emitArchiveWarnings(payload.warnings ?? []);
}

function emitArchiveWarnings(warnings: readonly ReviewArchiveWarning[]): void {
  for (const warning of warnings) process.stderr.write(`review archive: ${warning.message}\n`);
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/** Run `review comments` (the enriched read). Returns the process exit code. */
export async function runComments(args: ReviewArgs, root: string): Promise<number> {
  if (!args.branch) {
    process.stderr.write('review comments: --branch <branch> is required\n');
    return 1;
  }
  const paths = commentPaths(root, args.branch);
  try {
    emitPayload(await assemblePayload(args.branch, paths, root), args.json);
    return 0;
  } catch (error) {
    if (error instanceof DurableStateReadError || error instanceof ReviewStateHealthError) {
      if (args.json)
        process.stdout.write(`${JSON.stringify({ ok: false, health: error.health })}\n`);
      else process.stderr.write(`review comments: ${error.message}\n`);
      return 1;
    }
    throw error;
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
    process.stderr.write(`review comment ${verb}: --input '<json>' is required\n`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      process.stderr.write(`review comment ${verb}: --input must be a JSON object\n`);
      return null;
    }
    return parsed as ParsedInput;
  } catch {
    process.stderr.write(`review comment ${verb}: --input is not valid JSON\n`);
    return null;
  }
}

function coerceAuthor(raw: unknown, fallback: 'reviewer' | 'agent'): 'reviewer' | 'agent' | null {
  if (raw === undefined) return fallback;
  if (raw === 'reviewer' || raw === 'agent') return raw;
  process.stderr.write(`review comment: author must be 'reviewer' or 'agent'\n`);
  return null;
}

function coerceBody(raw: unknown, verb: string): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  process.stderr.write(`review comment ${verb}: a non-empty body is required\n`);
  return null;
}

/** Validate + append events under the per-slug lock, then emit the fresh payload. */
async function appendAndEmit(
  args: ReviewArgs,
  paths: CommentPaths,
  events: unknown[],
  root: string,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const rawLines: string[] = [];
  for (const event of events) {
    const result = commentEventSchema.safeParse(event);
    if (!result.success) {
      process.stderr.write(`review comment: invalid event (${issues(result.error)})\n`);
      return 1;
    }
    rawLines.push(JSON.stringify(result.data));
  }
  const lock = reviewLock(root, paths.locksDir);
  // Resolve the archive mirror BEFORE the lock (config/git reads must not widen
  // the critical section).
  const archive = await reviewArchiveMirror(root, env);
  const mirror = archive.mirror;
  try {
    await lock.withLock(reviewStateLockKey(paths.slug), async (stateLease) => {
      await lock.withLock(paths.slug, async (slugLease) => {
        await stateLease.verify();
        await slugLease.verify();
        await ensureReviewStateVersion(paths.dir, root);
        await readCommentEventsStrict(paths.file);
        await stateLease.verify();
        await slugLease.verify();
        await appendDurable(
          reviewEntryPath(root, paths.file, 'review comments'),
          rawLines.map((l) => `${l}\n`).join(''),
          root
        );
        // Hot first, mirror second, fail-open: the archive copy of each
        // just-appended line lands under the SAME slug lock (hot-lock →
        // archive-lock order).
        if (mirror) {
          for (const raw of rawLines) {
            await mirror.mirrorReviewEvent(
              REVIEW_STATE_VERSION,
              paths.slug,
              'comments',
              raw,
              reviewEventIdentity(raw)
            );
          }
        }
      });
    });
  } catch (error) {
    if (error instanceof DurableStateReadError) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            health: error.health,
            ...(archive.warnings.length > 0 ? { warnings: archive.warnings } : {}),
          })}\n`
        );
      } else {
        process.stderr.write(`review comment: ${error.message} — nothing appended\n`);
        emitArchiveWarnings(archive.warnings);
      }
      return 1;
    }
    throw error;
  }
  const payload = await assemblePayload(args.branch!, paths, root);
  if (archive.warnings.length > 0) payload.warnings = archive.warnings;
  emitPayload(payload, args.json);
  return 0;
}

/** Run `review comment add|reply|resolve|reopen`. Returns the process exit code. */
export async function runCommentAction(
  args: ReviewArgs,
  root: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (!args.branch) {
    process.stderr.write('review comment: --branch <branch> is required\n');
    return 1;
  }
  const paths = commentPaths(root, args.branch);
  const now = new Date().toISOString();

  if (args.action === 'add') {
    const input = parseInput(args.input, 'add');
    if (input === null) return 1;
    const author = coerceAuthor(input.author, 'reviewer');
    const body = coerceBody(input.body, 'add');
    const anchorResult = commentAnchorSchema.safeParse(input.anchor);
    if (author === null || body === null) return 1;
    if (!anchorResult.success) {
      process.stderr.write(`review comment add: invalid anchor (${issues(anchorResult.error)})\n`);
      return 1;
    }
    const anchor: CommentAnchor = anchorResult.data;
    return appendAndEmit(
      args,
      paths,
      [{ type: 'add', comment_id: randomUUID(), ts: now, author, body, anchor }],
      root,
      env
    );
  }

  if (args.action === 'reply' || args.action === 'resolve' || args.action === 'reopen') {
    if (args.id === undefined || args.id.length === 0) {
      process.stderr.write(`review comment ${args.action}: --id <comment_id> is required\n`);
      return 1;
    }
    let existing: CommentRecord[];
    try {
      existing = replayComments(await readCommentEventsStrict(paths.file));
    } catch (error) {
      if (error instanceof DurableStateReadError) {
        if (args.json)
          process.stdout.write(`${JSON.stringify({ ok: false, health: error.health })}\n`);
        else process.stderr.write(`review comment ${args.action}: ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    if (!existing.some((r) => r.comment_id === args.id)) {
      process.stderr.write(`review comment ${args.action}: unknown comment id '${args.id}'\n`);
      return 1;
    }

    if (args.action === 'resolve' || args.action === 'reopen') {
      const author = coerceAuthor(args.author, 'reviewer');
      if (author === null) return 1;
      return appendAndEmit(
        args,
        paths,
        [
          {
            type: 'status',
            comment_id: args.id,
            ts: now,
            author,
            status: args.action === 'resolve' ? 'resolved' : 'open',
          },
        ],
        root,
        env
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
        process.stderr.write(
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
    return appendAndEmit(args, paths, events, root, env);
  }

  process.stderr.write(`review comment: unknown action '${args.action ?? ''}'\n`);
  return 2;
}
