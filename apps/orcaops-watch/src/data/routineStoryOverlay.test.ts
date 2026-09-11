import { describe, expect, it } from 'vitest';

import type {
  PaneRoutineStory,
  SemanticAnchorModel,
  StoryReviewModel,
} from '@orcaops/review-engine';

import { loadRoutineStoryOverlay } from './reviewSource';

const model = { schema_version: 4, label: 'CODE_ONLY' } as unknown as StoryReviewModel;
const anchorModel = { schema_version: 3 } as unknown as SemanticAnchorModel;

const absentAnchors: PaneRoutineStory['anchors'] = {
  model: null,
  status: 'absent',
  issue: null,
  generation: null,
};

describe('loadRoutineStoryOverlay — canonical pane mapping', () => {
  it('carries an OK Story model, generation and anchors through unchanged', () => {
    const overlay = loadRoutineStoryOverlay({
      model,
      status: 'ok',
      issue: null,
      runId: 'run-1',
      generation: 'gen-1',
      anchors: { model: anchorModel, status: 'ok', issue: null, generation: 'anchor-1' },
    });
    expect(overlay).toEqual({
      model,
      status: 'ok',
      issue: null,
      runId: 'run-1',
      generation: 'gen-1',
      installationToken: 'run-1',
      anchors: { model: anchorModel, status: 'ok', issue: null, generation: 'anchor-1' },
    });
  });

  it('keeps a STALE Story viewable — model and generation survive for best-effort viewing', () => {
    const overlay = loadRoutineStoryOverlay({
      model,
      status: 'stale',
      issue: 'sealed against a different floor',
      runId: 'run-2',
      generation: 'gen-2',
      anchors: absentAnchors,
    });
    expect(overlay.model).toBe(model);
    expect(overlay.status).toBe('stale');
    expect(overlay.generation).toBe('gen-2');
    expect(overlay.installationToken).toBe('run-2');
  });

  it('drops the model and generation on an ABSENT or INVALID Story', () => {
    const absent = loadRoutineStoryOverlay({
      model: null,
      status: 'absent',
      issue: null,
      runId: null,
      generation: null,
      anchors: absentAnchors,
    });
    expect(absent.model).toBeNull();
    expect(absent.generation).toBeNull();
    expect(absent.installationToken).toBeNull();

    const invalid = loadRoutineStoryOverlay({
      model,
      status: 'invalid',
      issue: 'retained Story model is unreadable',
      runId: 'run-3',
      generation: 'gen-3',
      anchors: absentAnchors,
    });
    expect(invalid.model).toBeNull();
    expect(invalid.generation).toBeNull();
    expect(invalid.issue).toBe('retained Story model is unreadable');
  });

  it('drops an anchor model whose own status is not OK, keeping its status visible', () => {
    const overlay = loadRoutineStoryOverlay({
      model,
      status: 'ok',
      issue: null,
      runId: 'run-4',
      generation: 'gen-4',
      anchors: {
        model: anchorModel,
        status: 'invalid',
        issue: 'manifest mismatch',
        generation: null,
      },
    });
    expect(overlay.anchors.model).toBeNull();
    expect(overlay.anchors.status).toBe('invalid');
    expect(overlay.anchors.issue).toBe('manifest mismatch');
  });
});
