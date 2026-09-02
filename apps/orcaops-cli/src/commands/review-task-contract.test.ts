import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES } from '@orcaops/adapters';
import { parseReviewArgs } from '@orcaops/review-engine';

const taskReview = SKILL_TEMPLATES.find((skill) => skill.id === 'task-review')!;
const body = typeof taskReview.body === 'function' ? taskReview.body('orcaops') : taskReview.body;

describe('task-review skill and public CLI agreement', () => {
  it('documents the accepted comment reply surface and rejects unsupported flag aliases', () => {
    const input = JSON.stringify({
      body: 'answer',
      author: 'agent',
      checkpoint_ref: { artifact: 'artifact-a', cp: 2 },
    });
    const parsed = parseReviewArgs([
      'review',
      'comment',
      'reply',
      '--branch',
      'demo',
      '--id',
      'comment-a',
      '--input',
      input,
      '--resolve',
    ]);
    expect(parsed).toMatchObject({
      action: 'reply',
      id: 'comment-a',
      input,
      resolve: true,
    });
    expect(parsed.unknownArguments).toBeUndefined();
    expect(body).toContain('--id <id>');
    expect(body).toContain(`--input '{"body":"<answer>"`);
    expect(body).not.toContain('--comment <id>');
    expect(body).not.toContain('--body <answer>');

    expect(
      parseReviewArgs(['review', 'comment', 'reply', '--comment', 'comment-a', '--body', 'answer'])
        .unknownArguments
    ).toEqual(['--comment', 'comment-a', '--body', 'answer']);
  });

  it('documents and parses the explicit semantic-anchor submission without overloading review anchor', () => {
    const parsed = parseReviewArgs([
      'review',
      'semantic-anchor-submit',
      '--run',
      '22222222-2222-4222-8222-222222222222',
      '--generation',
      '33333333-3333-4333-8333-333333333333',
      '--profile',
      'semantic-anchor-profile-v1',
      '--input',
      '-',
      '--json',
    ]);
    expect(parsed).toMatchObject({
      sub: 'semantic-anchor-submit',
      runId: '22222222-2222-4222-8222-222222222222',
      generationId: '33333333-3333-4333-8333-333333333333',
      profile: 'semantic-anchor-profile-v1',
      input: '-',
      json: true,
    });
    expect(parsed.unknownArguments).toBeUndefined();
    expect(body).toContain('orcaops review semantic-anchor-submit --run <run-id>');
    expect(body).not.toContain('semantic-anchor-start');
    expect(body).toContain('review anchor verb remains a separate stateless helper');
  });
});
