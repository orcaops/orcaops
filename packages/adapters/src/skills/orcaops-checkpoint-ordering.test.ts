import { describe, expect, it } from 'vitest';

import { orcaopsCheckpointSkill } from './orcaops-checkpoint.js';

describe('checkpoint skill — commit-before-close ordering', () => {
  const body =
    typeof orcaopsCheckpointSkill.body === 'function'
      ? orcaopsCheckpointSkill.body('orcaops')
      : orcaopsCheckpointSkill.body;

  it('states the full ordering, not just "commit at close"', () => {
    expect(body).toContain('COMMIT BEFORE YOU CLOSE');
    expect(body).toContain('open → make changes →');
    expect(body).toContain('run formatters and tests → commit → close');
  });

  it('gives the REASON, which is what makes the rule followable', () => {
    // "Commit at close" alone is ambiguous about hook rewrites, and a rewrite
    // landing after the close is a worktree change attributed to nothing.
    expect(body).toContain('pre-commit hook that');
    expect(body).toContain('attributed to nothing');
  });
});
