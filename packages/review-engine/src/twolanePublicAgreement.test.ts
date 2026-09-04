import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CURRENT_STORY_POINTER_SCHEMA_VERSION } from './currentStory.js';
import { FLOOR_PRODUCER_VERSION } from './floor.js';
import { REVIEW_STATE_VERSION } from './reviewState.js';
import { STORY_REVIEW_MODEL_SCHEMA_VERSION } from './storyReviewModel.js';
import { TWOLANE_FINALIZE_ERROR_CODES, TWOLANE_RUN_SCHEMA_VERSION } from './twolaneRunCli.js';
import { SLICE_DIAGNOSTIC_CODES, SLICE_SCHEMA_VERSION } from './twolaneSlice.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

describe('public two-lane routine agreement', () => {
  it('keeps public lifecycle schemas aligned with live constants', async () => {
    const surfaces = await Promise.all([
      text('apps/docs/content/task-review-protocol.md'),
      text('packages/adapters/src/skills/orcaops-task-review.ts'),
      text('.agents/skills/orcaops-task-review/SKILL.md'),
      text('.claude/skills/orcaops-task-review/SKILL.md'),
    ]);
    const versionStatements = [
      `run schema ${TWOLANE_RUN_SCHEMA_VERSION}`,
      `slice state schema ${SLICE_SCHEMA_VERSION}`,
      `Story review model schema ${STORY_REVIEW_MODEL_SCHEMA_VERSION}`,
      `current Story pointer schema ${CURRENT_STORY_POINTER_SCHEMA_VERSION}`,
      `durable review-state version ${REVIEW_STATE_VERSION}`,
      `floor producer version ${FLOOR_PRODUCER_VERSION}`,
    ];

    for (const surface of surfaces) {
      const normalized = surface.replace(/\s+/g, ' ');
      for (const statement of versionStatements) expect(normalized).toContain(statement);
      expect(normalized).toContain('orcaops review routine-start');
      expect(normalized).toContain('orcaops review routine-submit');
      expect(normalized).not.toContain('orcaops review compose');
    }
  });

  it('keeps the documented lifecycle and repair signals on the canonical program', async () => {
    const [docs, sourceSkill, agentsSkill, claudeSkill] = await Promise.all([
      text('apps/docs/content/task-review-protocol.md'),
      text('packages/adapters/src/skills/orcaops-task-review.ts'),
      text('.agents/skills/orcaops-task-review/SKILL.md'),
      text('.claude/skills/orcaops-task-review/SKILL.md'),
    ]);

    expect(docs).toContain('.orcaops/reviews/<branch-slug>/twolane/<run-id>/');
    expect(docs).toContain('run-record-v1.json');
    expect(docs).toContain('current-story-v1.json');
    expect(docs).toContain('story-review-model-v4.json');
    for (const instructions of [sourceSkill, agentsSkill, claudeSkill]) {
      expect(instructions).toContain('BOUNDED ROUTINE REVIEW');
      expect(instructions).toContain('never calls a model');
    }
    for (const code of [
      'FORENSIC_TRANSPORT_CEILING',
      'ACCOUNT_CORPUS_CEILING',
      'REVIEW_DIFF_TRUNCATED',
      'TWOLANE_ROUTINE_ORDER',
      'SLICE_PAYLOAD_SHAPE',
      'SLICE_ROUTINE_LIMITS',
      'SLICE_UNKNOWN_FILE',
      'SLICE_UNKNOWN_CITATION',
      'SLICE_OVERVIEW_ALIAS_LEAK',
      'STORY_CHECKPOINT_UNCLAIMED',
      'STORY_CHECKPOINT_DUPLICATED',
      'STORY_UNKNOWN_CHECKPOINT_REF',
      'SLICE_SUBMIT_AFTER_ACCEPT',
      'TWOLANE_ATTEMPT_BUDGET',
      ...TWOLANE_FINALIZE_ERROR_CODES,
      ...SLICE_DIAGNOSTIC_CODES,
    ]) {
      expect(docs, code).toContain(code);
      for (const instructions of [sourceSkill, agentsSkill, claudeSkill]) {
        expect(instructions, code).toContain(code);
      }
    }
    expect(docs).not.toContain('STORY_OPEN_OR_ABANDONED_MEMBER');
  });
});
