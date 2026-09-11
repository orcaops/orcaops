import path from 'node:path';
import { z } from 'zod';

import {
  HistoryScopeError,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import {
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
} from '@orcaops/storage/history/database';

import { hydrateReviewComments, snapshotReviewComments } from './comment-read.js';
import { hydrateDatabaseReviewFloor, snapshotDatabaseReviewFloor } from './floors.js';
import { decodeRetainedReviewJson } from './records.js';
import { integrity, revisionId, text, validate } from './request.js';
import { selectDatabaseReview } from './review-selection.js';
import { baseSchema, hydrateDatabaseReview, selection, snapshotDatabaseReview } from './reviews.js';
import {
  hydrateDatabaseReviewFinalization,
  snapshotDatabaseReviewFinalization,
} from './run-finalization-read.js';
import { hydrateReviewRun, snapshotReviewRun } from './run-read.js';
import { closeDatabaseReviewScope } from './source-scope.js';
import { hydrateReviewWorkflow, snapshotReviewWorkflow } from './workflow-read.js';

const requestSchema = z
  .strictObject({
    projectId: revisionId.optional(),
    reviewId: revisionId.optional(),
    branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)).optional(),
    cwd: text.optional(),
    dataRoot: text.optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
  })
  .refine((value) => value.reviewId !== undefined || value.branch !== undefined);
export type ReadDatabaseReviewContext = z.infer<typeof requestSchema>;

/**
 * Resolve the review's project history, hand a reader to `use`, and close the
 * scope afterward. The full context read and the focused reads (pane change
 * tokens, workflow context) share this one open/complete/close path so each can
 * read only the slice it needs without repeating the resolution boilerplate.
 */
export async function withDatabaseReviewScope<T>(
  input: {
    cwd: string;
    dataRoot?: string;
    projectId?: string;
    env: Record<string, string | undefined>;
  },
  use: (project: {
    database: ProjectDatabase;
    authority: ProjectDatabaseAuthority;
    projectId: string;
  }) => Promise<T> | T
): Promise<T> {
  const scope = await resolveDatabaseHistoryScope({
    cwd: input.cwd,
    root: input.dataRoot,
    env: input.env,
    selector: input.projectId ? { projectId: input.projectId } : {},
    profile: 'exact',
  });
  let primary: unknown;
  try {
    const project = scope.projects[0];
    if (!scope.completeness.complete || !project?.database || !project.authority) {
      const issue = scope.completeness.issues[0];
      throw new HistoryScopeError(
        issue?.code ?? 'HISTORY_MISSING',
        issue?.message ??
          'Expected project history is unavailable; preserve it for explicit repair',
        { issues: scope.completeness.issues }
      );
    }
    return await use({
      database: project.database,
      authority: project.authority,
      projectId: project.projectId,
    });
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    closeDatabaseReviewScope(scope, primary);
  }
}

export async function readDatabaseReviewContext(raw: ReadDatabaseReviewContext) {
  const request = validate(requestSchema, raw);
  const input = {
    ...request,
    cwd: path.resolve(request.cwd ?? process.cwd()),
    env: { ...(request.env ?? process.env) },
  };
  return withDatabaseReviewScope(input, async ({ database, authority, projectId }) => {
    const snapshot = database.read((view) => {
      const reviewId = selectDatabaseReview(view, input, projectId);
      const review = snapshotDatabaseReview(view, reviewId);
      if (!review)
        throw new HistoryScopeError(
          'REVIEW_NOT_FOUND',
          'The exact review is not retained in the selected project'
        );
      if (input.branch !== undefined && review.row.branch !== input.branch)
        throw new HistoryScopeError(
          'REVIEW_CONTEXT_MISMATCH',
          'The exact review does not belong to the requested branch; retain its original identity'
        );
      const selected = review.selection;
      const common = { authority, reviewId };
      const base =
        selected.base_revision_id === null
          ? null
          : view.get<{ revision_id: string; record_hex: string; record_hash: string }>(
              'SELECT revision_id,hex(record_bytes) AS record_hex,record_hash FROM review_base_revisions WHERE review_id = ? AND revision_id = ?',
              reviewId,
              selected.base_revision_id
            );
      if (selected.base_revision_id !== null && !base)
        integrity('Selected review base history is missing; preserve its original records');
      const floor = snapshotDatabaseReviewFloor(view, common);
      const run = snapshotReviewRun(view, common);
      const storyOwner =
        selected.story_publication_id === null
          ? null
          : view.get<{ run_id: string | null; run_revision_id: string | null }>(
              "SELECT run_id,run_revision_id FROM review_evidence_publications WHERE review_id = ? AND publication_id = ? AND kind = 'story'",
              reviewId,
              selected.story_publication_id
            );
      if (
        selected.story_publication_id !== null &&
        (!storyOwner?.run_id || !storyOwner.run_revision_id)
      )
        integrity('The selected Story publication has lost its exact retained run owner');
      const story = storyOwner?.run_id
        ? snapshotDatabaseReviewFinalization(view, { ...common, runId: storyOwner.run_id })
        : null;
      if (
        story &&
        (story.run.revision_id !== storyOwner!.run_revision_id ||
          !story.publications.some(
            (p) => p.kind === 'story' && p.publication_id === selected.story_publication_id
          ))
      )
        integrity('The selected Story does not belong to its exact retained sealed run revision');
      return {
        reviewId,
        review,
        base: base ?? null,
        floor,
        run,
        story,
        storyOwner,
        comments: snapshotReviewComments(view, reviewId),
        workflow: snapshotReviewWorkflow(view, reviewId),
      };
    });
    const { reviewId } = snapshot.value;
    const common = { authority, reviewId };
    const review = hydrateDatabaseReview(authority, snapshot.value.review)!;
    const base = snapshot.value.base
      ? decodeRetainedReviewJson(baseSchema, Buffer.from(snapshot.value.base.record_hex, 'hex'))
      : null;
    if (base && base.sha256 !== snapshot.value.base!.record_hash)
      integrity('Selected review base bytes differ from their retained hash');
    const comments = hydrateReviewComments(snapshot.value.comments);
    const workflow = await hydrateReviewWorkflow(snapshot.value.workflow);
    const run = await hydrateReviewRun(database, {
      value: snapshot.value.run,
      counters: snapshot.counters,
    });
    const floor = await hydrateDatabaseReviewFloor(database, common, {
      value: snapshot.value.floor,
      counters: snapshot.counters,
    });
    const story = snapshot.value.story
      ? await hydrateDatabaseReviewFinalization(
          database,
          { ...common, runId: snapshot.value.storyOwner!.run_id! },
          { value: snapshot.value.story, counters: snapshot.counters }
        )
      : null;
    if (snapshot.value.story && !story?.value)
      integrity('Selected Story evidence lacks its original terminal receipt');
    return {
      authority: { ...authority },
      projectId,
      reviewId,
      ...review,
      base: base
        ? {
            revisionId: snapshot.value.base!.revision_id,
            record: base.value,
            bytes: base.bytes,
            hash: base.sha256,
          }
        : null,
      comments,
      workflow,
      run: run.value,
      floor: floor.value,
      story: story?.value ?? null,
      storyMatchesSelectedFloor:
        snapshot.value.story === null
          ? null
          : snapshot.value.story.run.floor_publication_id === review.selection.floor_publication_id,
      counters: snapshot.counters,
    };
  });
}

/**
 * The workflow slice a disposition append needs: the review identity, its
 * selection (floor, Story and their versions) and the current workflow target
 * heads. Deliberately reads none of the comments, run, retained review evidence
 * or Story the full context read hydrates — a disposition pins its floor/Story
 * by selection version and its targets by head, and needs nothing more.
 */
export async function readDatabaseReviewWorkflowContext(raw: ReadDatabaseReviewContext) {
  const request = validate(requestSchema, raw);
  const input = {
    ...request,
    cwd: path.resolve(request.cwd ?? process.cwd()),
    env: { ...(request.env ?? process.env) },
  };
  return withDatabaseReviewScope(input, ({ database, authority, projectId }) => {
    const snapshot = database.read((view) => {
      const reviewId = selectDatabaseReview(view, input, projectId);
      const row = view.get<{ branch: string | null }>(
        'SELECT branch FROM reviews WHERE review_id = ?',
        reviewId
      );
      if (!row)
        throw new HistoryScopeError(
          'REVIEW_NOT_FOUND',
          'The exact review is not retained in the selected project'
        );
      if (input.branch !== undefined && row.branch !== input.branch)
        throw new HistoryScopeError(
          'REVIEW_CONTEXT_MISMATCH',
          'The exact review does not belong to the requested branch; retain its original identity'
        );
      return {
        reviewId,
        selection: selection(view, reviewId),
        heads: snapshotReviewWorkflow(view, reviewId).heads,
      };
    }).value;
    return {
      authority: { ...authority },
      projectId,
      reviewId: snapshot.reviewId,
      selection: snapshot.selection,
      floor:
        snapshot.selection.floor_publication_id === null
          ? null
          : { publicationId: snapshot.selection.floor_publication_id },
      workflow: { heads: snapshot.heads },
    };
  });
}
