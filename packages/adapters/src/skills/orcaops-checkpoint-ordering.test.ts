import { describe, expect, it } from 'vitest';

import { orcaopsCheckpointSkill } from './orcaops-checkpoint.js';

describe('checkpoint commit guidance', () => {
  const body =
    typeof orcaopsCheckpointSkill.body === 'function'
      ? orcaopsCheckpointSkill.body('orcaops')
      : orcaopsCheckpointSkill.body;

  it('states ordering without granting commit authority', () => {
    expect(body).toContain('IF A COMMIT IS AUTHORIZED AND INTENDED');
    expect(body).toContain('open → make changes →');
    expect(body).toContain("stage only this\ncheckpoint's files → commit → close");
    expect(body).toContain('Do not create a commit merely because you opened a checkpoint');
    expect(body).toContain('do\nnot stage unrelated dirty-worktree or sibling-agent changes');
  });

  it('gives the REASON, which is what makes the rule followable', () => {
    // "Commit at close" alone is ambiguous about hook rewrites, and a rewrite
    // landing after the close is a worktree change attributed to nothing.
    expect(body).toContain('pre-commit hook can');
    expect(body).toMatch(/attributed to\s+nothing/);
  });
});
