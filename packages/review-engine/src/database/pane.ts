// The Watch review pane over the canonical store. `readDatabaseReviewContext`
// composes most of what the pane needs — the floor and its diff, the comments,
// the workflow history, the run, its finalization and the Story model — and
// this projects that into the payload the pane renders, then reads the retained
// semantic generation for the Story's run for the anchor overlay (a second
// short read-only pass; see `paneAnchors`). It reads no review directory file:
// the floor and diff are retained evidence, the Story is the sealed run's
// retained publication, and the anchors are the retained semantic generation.

import path from 'node:path';

import { type Floor } from '@orcaops/review-core';

import { type SemanticAnchorModel } from '../semanticAnchorGenerations.js';
import {
  parseStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  type StoryReviewModel,
} from '../storyReviewModel.js';
import { readDatabaseReviewContext, withDatabaseReviewScope } from './read-context.js';
import { integrity } from './request.js';
import { selectDatabaseReview } from './review-selection.js';
import { selection } from './reviews.js';
import { readDatabaseSemanticGeneration } from './semantic-read.js';

export type PaneStoryStatus = 'absent' | 'stale' | 'invalid' | 'ok';

export interface PaneStoryAnchors {
  model: SemanticAnchorModel | null;
  status: PaneStoryStatus;
  issue: string | null;
  generation: string | null;
}

export interface PaneRoutineStory {
  model: StoryReviewModel | null;
  status: PaneStoryStatus;
  issue: string | null;
  runId: string | null;
  generation: string | null;
  anchors: PaneStoryAnchors;
}

export interface DatabaseReviewPane {
  reviewId: string;
  floor: Floor;
  diff: string;
  routineStory: PaneRoutineStory;
  /** Retained selection versions, for the pane's cheap invalidation probe. */
  generations: {
    floor: string | null;
    story: string | null;
    storyInstallation: string | null;
    storyAnchors: string | null;
    comments: string | null;
    workflow: string | null;
  };
}

const ABSENT_ANCHORS: PaneStoryAnchors = {
  model: null,
  status: 'absent',
  issue: null,
  generation: null,
};

/**
 * Assemble the pane from one short read. A review with no selected floor has
 * nothing to render, so this returns null rather than a floorless pane.
 */
export async function readDatabaseReviewPane(input: {
  branch: string;
  cwd: string;
  projectId?: string;
  dataRoot?: string;
}): Promise<DatabaseReviewPane | null> {
  const context = await readDatabaseReviewContext({
    branch: input.branch,
    cwd: input.cwd,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  if (context.floor === null) return null;

  const floor = context.floor.floor as Floor;
  const diff = Buffer.from(context.floor.diffBytes).toString('utf8');

  let routineStory: PaneRoutineStory = {
    model: null,
    status: 'absent',
    issue: null,
    runId: null,
    generation: null,
    anchors: ABSENT_ANCHORS,
  };

  const story = context.story;
  if (story !== null) {
    const storyPublication = story.publications.find((publication) => publication.kind === 'story');
    const modelMember = storyPublication?.members.find(
      (member) => member.name === STORY_REVIEW_MODEL_FILE
    );
    // The Story is sealed against a floor. When that floor is no longer the
    // review's selected floor, the model is not the lens a reviewer could have
    // read over the current floor: it is retained but STALE.
    const status: PaneStoryStatus =
      context.storyMatchesSelectedFloor === false ? 'stale' : modelMember ? 'ok' : 'invalid';
    let model: StoryReviewModel | null = null;
    let issue: string | null = null;
    if (modelMember) {
      try {
        model = parseStoryReviewModel(JSON.parse(Buffer.from(modelMember.bytes).toString('utf8')));
      } catch (error) {
        issue = `retained Story model is unreadable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const anchors = await paneAnchors(context.authority, context.reviewId, story.runId, status);
    routineStory = {
      // A stale Story is still shown; the default lens and finish basis gate on
      // status/generation elsewhere, never on model presence.
      model: status === 'ok' || status === 'stale' ? model : null,
      status: model === null && status !== 'stale' ? 'invalid' : status,
      issue,
      runId: story.runId,
      generation: storyPublication?.generation ?? null,
      anchors,
    };
  }

  return {
    reviewId: context.reviewId,
    floor,
    diff,
    routineStory,
    generations: {
      floor: context.floor.publicationId,
      story: routineStory.generation,
      storyInstallation: story?.runId ?? null,
      storyAnchors: routineStory.anchors.generation,
      comments: `${context.comments.heads.length}:${context.comments.heads.reduce((sum, head) => sum + head.version, 0)}`,
      workflow: String(context.workflow.sequence),
    },
  };
}

/**
 * The retained semantic generation for the Story's run, as the pane's anchor
 * overlay. Anchors load for a STALE Story too — the generation is validated
 * against its own run and the viewer reconciles targets against the current
 * diff — but not for an absent or invalid Story.
 */
async function paneAnchors(
  authority: Parameters<typeof readDatabaseSemanticGeneration>[0]['authority'],
  reviewId: string,
  runId: string | null,
  storyStatus: PaneStoryStatus
): Promise<PaneStoryAnchors> {
  if (runId === null || (storyStatus !== 'ok' && storyStatus !== 'stale')) return ABSENT_ANCHORS;
  const semantic = await readDatabaseSemanticGeneration({ authority, reviewId, runId });
  if (!semantic.value || semantic.value.current === null || semantic.value.model === null)
    return ABSENT_ANCHORS;
  return {
    model: semantic.value.model.value as SemanticAnchorModel,
    status: 'ok',
    issue: null,
    generation: semantic.value.generationId,
  };
}

/**
 * The pane's change tokens alone — the cheap invalidation probe behind
 * `--generations-only`. It reads the selection, comment heads, workflow depth
 * and the Story/anchor generations, but never hydrates the floor diff, the Story
 * model or the comment and run histories the full pane assembles. Returns null
 * on the same no-selected-floor condition the full pane returns null for.
 */
export async function readDatabaseReviewPaneGenerations(input: {
  branch: string;
  cwd: string;
  projectId?: string;
  dataRoot?: string;
}): Promise<{ reviewId: string; generations: DatabaseReviewPane['generations'] } | null> {
  const probe = await withDatabaseReviewScope(
    {
      cwd: path.resolve(input.cwd),
      ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      env: { ...process.env },
    },
    ({ database, authority, projectId }) => {
      const value = database.read((view) => {
        const reviewId = selectDatabaseReview(view, { branch: input.branch }, projectId);
        const current = selection(view, reviewId);
        if (current.floor_publication_id === null) return null;
        const commentHeads = view.all<{ version: number }>(
          'SELECT version FROM review_comments WHERE review_id = ?',
          reviewId
        );
        const workflow = view.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM review_workflow_transitions WHERE review_id = ?',
          reviewId
        )!.n;
        let story: {
          generation: string | null;
          runId: string;
          anchorsRunId: string | null;
        } | null = null;
        if (current.story_publication_id !== null) {
          const publication = view.get<{
            generation: string | null;
            run_id: string | null;
            run_revision_id: string | null;
          }>(
            "SELECT generation, run_id, run_revision_id FROM review_evidence_publications WHERE review_id = ? AND publication_id = ? AND kind = 'story'",
            reviewId,
            current.story_publication_id
          );
          if (!publication || publication.run_id === null || publication.run_revision_id === null)
            integrity('The selected Story publication has lost its exact retained run owner');
          const runFloor = view.get<{ floor_publication_id: string }>(
            `SELECT r.floor_publication_id FROM review_runs h
             JOIN review_run_revisions r
               ON r.run_id = h.run_id AND r.review_id = h.review_id AND r.revision_id = h.current_revision_id
             WHERE h.run_id = ? AND h.review_id = ?`,
            publication.run_id,
            reviewId
          );
          if (!runFloor)
            integrity('The selected Story run revision is missing; preserve history for repair');
          // Anchors load for an ok (model present) or stale (floor moved) Story,
          // matching the full pane's status gate.
          const matchesSelectedFloor =
            runFloor.floor_publication_id === current.floor_publication_id;
          const modelMember = view.get(
            'SELECT 1 FROM review_evidence_members WHERE publication_id = ? AND name = ?',
            current.story_publication_id,
            STORY_REVIEW_MODEL_FILE
          );
          story = {
            generation: publication.generation,
            runId: publication.run_id,
            anchorsRunId: !matchesSelectedFloor || modelMember ? publication.run_id : null,
          };
        }
        return {
          reviewId,
          floor: current.floor_publication_id,
          comments: `${commentHeads.length}:${commentHeads.reduce((sum, head) => sum + head.version, 0)}`,
          workflow: String(workflow),
          story,
        };
      }).value;
      return value === null ? null : { ...value, authority: { ...authority } };
    }
  );
  if (probe === null) return null;

  let storyAnchors: string | null = null;
  if (probe.story?.anchorsRunId != null) {
    const semantic = await readDatabaseSemanticGeneration({
      authority: probe.authority,
      reviewId: probe.reviewId,
      runId: probe.story.anchorsRunId,
    });
    if (semantic.value && semantic.value.current !== null && semantic.value.model !== null)
      storyAnchors = semantic.value.generationId;
  }
  return {
    reviewId: probe.reviewId,
    generations: {
      floor: probe.floor,
      story: probe.story?.generation ?? null,
      storyInstallation: probe.story?.runId ?? null,
      storyAnchors,
      comments: probe.comments,
      workflow: probe.workflow,
    },
  };
}
