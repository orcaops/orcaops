import { z } from 'zod';

import { type CommentAnchor, contextLineHash, type Floor, lineHash } from '@orcaops/review-core';
import { type ProjectDatabase } from '@orcaops/storage/history/database';

import { isolatedReviewGitEnvironment, runGit } from '../git.js';
import { parsePatchHunks } from '../patchHunks.js';
import { readDatabaseReviewFloor } from './floors.js';
import {
  decodeRetainedReviewRecord,
  decodeRetainedReviewText,
  prepareReviewRecords,
} from './records.js';
import {
  authoritySchema,
  cancelled,
  integrity,
  invalid,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  version,
  withReviewDatabase,
} from './request.js';
import { selection } from './reviews.js';

export const commentPreparationSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  floorPublicationId: revisionId,
  expected: z.strictObject({ floorVersion: version, membershipRevisionId: revisionId }),
  commentBytes: z.instanceof(Uint8Array),
  gitRoot: text.optional(),
  secretAllow: z.array(z.string()),
});
export type PrepareDatabaseReviewComment = Omit<
  z.infer<typeof commentPreparationSchema>,
  'commentBytes'
> & { commentBytes: Uint8Array };

async function readContextGit(
  gitRoot: string,
  args: string[],
  signal?: AbortSignal
): Promise<Buffer> {
  cancelled(signal);
  let result;
  try {
    result = await runGit(gitRoot, args, { env: isolatedReviewGitEnvironment(process.env) });
  } catch {
    cancelled(signal);
    integrity('The retained context Git evidence is unavailable; restore it before retrying');
  }
  cancelled(signal);
  if (result.code !== 0)
    integrity('The retained context Git evidence is unavailable; restore it before retrying');
  return result.stdout;
}

async function validateAnchor(
  anchor: CommentAnchor,
  floor: Floor,
  diffText: string,
  gitRoot: string | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  cancelled(signal);
  const hunks = parsePatchHunks(diffText, new Set([anchor.file]));
  const thread =
    anchor.threadKey === undefined
      ? undefined
      : floor.outline.threads.find((candidate) => candidate.threadKey === anchor.threadKey);
  if (anchor.threadKey !== undefined && thread === undefined)
    invalid('The comment section is absent from its exact retained floor');
  if (anchor.kind === 'UNCHANGED_CONTEXT_LINE') {
    if (!gitRoot) invalid('Provide a Git checkout containing the exact retained context blob');
    if (
      anchor.file.startsWith('/') ||
      anchor.file.includes('\0') ||
      anchor.file.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      invalid('The comment must name an exact repository-relative file');
    const tree = floor.scope.pinned_tree_sha;
    if (!tree || !/^[0-9a-f]{40,64}$/.test(tree))
      integrity('The retained floor has no exact pinned tree for context validation');
    const entry = await readContextGit(
      gitRoot,
      ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree, '--', anchor.file],
      signal
    );
    const records = entry.toString('utf8').split('\0').filter(Boolean);
    const match =
      records.length === 1 ? /^\d{6} blob ([0-9a-f]+)\t([\s\S]+)$/.exec(records[0]!) : null;
    if (!match || match[2] !== anchor.file || match[1] !== anchor.headBlobOid)
      invalid('The comment blob does not match its file in the retained pinned tree');
    const blob = await readContextGit(gitRoot, ['cat-file', 'blob', anchor.headBlobOid], signal);
    const lines = decodeRetainedReviewText(blob).text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const body = lines[anchor.line - 1];
    if (body === undefined || (await contextLineHash(body)) !== anchor.lineHash)
      invalid('The comment context line or hash differs from its retained blob');
    if (
      hunks.some((hunk) =>
        hunk.lines.some((line) => line.side === 'add' && line.new === anchor.line)
      )
    )
      invalid('A changed diff row must use a diff anchor rather than unchanged context');
    cancelled(signal);
    return;
  }
  const end = anchor.kind === 'DIFF_RANGE' ? anchor.endLine : anchor.line;
  const expectedHashes = anchor.kind === 'DIFF_RANGE' ? anchor.lineHashes : [anchor.lineHash];
  for (const hunk of hunks) {
    const rows = hunk.lines.filter((line) => {
      const number = anchor.side === 'add' ? line.new : line.old;
      return line.side === anchor.side && number !== null && number >= anchor.line && number <= end;
    });
    if (
      rows.length === 0 ||
      (anchor.side === 'add' ? rows[0]!.new : rows[0]!.old) !== anchor.line ||
      (anchor.side === 'add' ? rows.at(-1)!.new : rows.at(-1)!.old) !== end ||
      rows.length !== expectedHashes.length
    )
      continue;
    const coverage = floor.coverage.items.find(
      (item) =>
        item.file === anchor.file &&
        item.old_start === hunk.oldStart &&
        item.new_start === hunk.newStart
    );
    if (!coverage || (anchor.hunkKey !== undefined && anchor.hunkKey !== coverage.hunkKey))
      continue;
    if (
      thread &&
      !coverage.units.some((unit) => {
        if (unit.kind !== 'owned_slice') return false;
        const range = anchor.side === 'add' ? unit.add_range : unit.del_range;
        return (
          range !== null &&
          anchor.line >= range.start &&
          anchor.line <= range.end &&
          thread.checkpoints.some((checkpoint) =>
            checkpoint.sliceRefs.some(
              (ref) => ref.hunkKey === coverage.hunkKey && ref.slice === unit.slice
            )
          )
        );
      })
    )
      continue;
    const hashes = await Promise.all(
      rows.map((row) => lineHash(anchor.side, new TextEncoder().encode(row.body)))
    );
    cancelled(signal);
    if (hashes.every((hash, index) => hash === expectedHashes[index])) return;
  }
  invalid(
    'The comment must retain the exact changed rows, ordered hashes and floor anchor identities'
  );
}

export async function prepareDatabaseReviewComment(
  raw: PrepareDatabaseReviewComment,
  options: { signal?: AbortSignal } = {}
) {
  const signal = options.signal;
  const input = validate(commentPreparationSchema, raw);
  const [record] = prepareReviewRecords({
    records: [{ kind: 'comment', bytes: input.commentBytes }],
    secretAllow: input.secretAllow,
  });
  const event = decodeRetainedReviewRecord({ kind: 'comment', bytes: record!.bytes }).value;
  if (event.type !== 'add') invalid('Comment anchor preparation requires an original add event');
  scanMetadata(
    {
      authority: input.authority,
      reviewId: input.reviewId,
      expected: input.expected,
      floorPublicationId: input.floorPublicationId,
      gitRoot: input.gitRoot,
    },
    input.secretAllow
  );
  cancelled(signal);
  return withReviewDatabase(input.authority, 'reader', async (database: ProjectDatabase) => {
    const snapshot = database.read((view) => {
      const current = selection(view, input.reviewId);
      if (
        current.floor_publication_id !== input.floorPublicationId ||
        current.floor_version !== input.expected.floorVersion ||
        current.membership_revision_id !== input.expected.membershipRevisionId
      )
        stale('The selected comment floor or membership changed; prepare a new operation');
      if (
        view.get(
          'SELECT comment_id FROM review_comments WHERE review_id = ? AND comment_id = ?',
          input.reviewId,
          event.comment_id
        )
      )
        stale('This comment identity already exists; use its exact revision or original operation');
      return null;
    });
    const retained = await readDatabaseReviewFloor({
      authority: input.authority,
      reviewId: input.reviewId,
      publicationId: input.floorPublicationId,
    });
    cancelled(signal);
    if (
      retained.value === null ||
      retained.value.membershipRevisionId !== input.expected.membershipRevisionId
    )
      integrity('The exact comment floor membership is unavailable; preserve history for repair');
    await validateAnchor(
      event.anchor,
      retained.value.floor,
      decodeRetainedReviewText(retained.value.diffBytes).text,
      input.gitRoot,
      signal
    );
    return {
      commentBytes: record!.bytes,
      commentHash: record!.sha256,
      comment: event,
      floorPublicationId: input.floorPublicationId,
      membershipRevisionId: input.expected.membershipRevisionId,
      floorVersion: input.expected.floorVersion,
      counters: snapshot.counters,
    };
  });
}
