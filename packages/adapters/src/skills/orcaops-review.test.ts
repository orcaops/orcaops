import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES } from './index.js';
import { orcaopsReviewSkill } from './orcaops-review.js';

describe('orcaops-review skill', () => {
  it('registers in the skill index', () => {
    expect(SKILL_TEMPLATES.some((s) => s.id === orcaopsReviewSkill.id)).toBe(true);
  });

  it('codifies the non-negotiable protocol lines', () => {
    const body = orcaopsReviewSkill.body;
    expect(body).toContain("reply-don't-resolve");
    expect(body).toContain('orcaops review pull');
    expect(body).toContain('orcaops review watch');
    expect(body).toContain('--pass-token');
    expect(body).toContain('exit 2');
    expect(body).toContain('has_new_human_activity');
    expect(body).toContain('stand down');
    expect(body).toMatch(/dry cycles?/i);
    // The human verb stays out of the agent loop:
    expect(body).toContain('never run `orcaops review resolve`');
  });
});
