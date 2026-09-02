import type { FixtureFile } from '@orcaops/storage';

const ARTIFACT_ID = 'example-artifact';
const STEP_ONE = '019e0000-0000-7000-8000-000000000001';
const STEP_TWO = '019e0000-0000-7000-8000-000000000002';
const CRITERION_ONE = '019e0000-0000-7000-8000-000000000101';
const BASE_SHA = '0000000000000000000000000000000000000000';
const HEAD_SHA = '1111111111111111111111111111111111111111';

/**
 * A complete, valid `eval test` fixture, for `--print-example-fixture`.
 *
 * Hand-written on purpose: Zod validates, it cannot generate. A test parses
 * this against `FixtureFileSchema` and runs it end to end, which is what keeps
 * it honest as the schema moves.
 *
 * It deliberately exercises the awkward parts rather than the minimum: a
 * closed checkpoint AND an open one (the shape a `checkpoint-open` evaluator
 * needs), acceptance criteria with matching `done_criteria` evidence, and
 * `verification` — the fields an author is most likely to get wrong. No
 * summary, because one cannot coexist with an open checkpoint.
 */
export function exampleFixture(): FixtureFile {
  return {
    plan: {
      schema_version: 4,
      artifact_id: ARTIFACT_ID,
      branch: 'main',
      base_sha: BASE_SHA,
      agent: 'claude-code',
      agent_session_id: null,
      task: 'add rate limiting to the charge endpoint',
      label: 'rate limit /api/charge',
      plan_steps: [
        {
          step_id: STEP_ONE,
          text: 'implement the sliding-window middleware',
          label: 'middleware',
          acceptance_criteria: [
            { criterion_id: CRITERION_ONE, text: 'the limiter is shared across instances' },
          ],
        },
        {
          step_id: STEP_TWO,
          text: 'add tests for the limit-exceeded path',
          label: 'tests',
          acceptance_criteria: [],
        },
      ],
      touched_scope: ['payments'],
      non_goals: [
        {
          text: 'do not change the existing auth middleware',
          rationale: 'auth is a separate slice',
          source_refs: [],
        },
      ],
      decisions: [],
      started_at: '2026-01-01T00:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    },
    checkpoints: [
      {
        status: 'closed',
        artifact_id: ARTIFACT_ID,
        n: 1,
        declared_step_ids: [STEP_ONE],
        policy_exceptions: [],
        plan_revision_id: null,
        head_sha: HEAD_SHA,
        summary: 'added the sliding-window middleware backed by the shared redis client',
        files_changed: ['src/middleware/rate-limit.ts'],
        decisions: [
          {
            decision: 'sliding window over a fixed-window counter',
            reason: 'a fixed window allows a 2x burst at the boundary',
          },
        ],
        uncertainty: ['TTL strategy if a second region is added'],
        done_criteria: [
          { criterion_id: CRITERION_ONE, evidence: 'state lives in redis, not process memory' },
        ],
        verification: [{ command: 'pnpm test', exit_code: 0 }],
        completed_step_ids: [STEP_ONE],
      },
      {
        // Left open, which is what a `checkpoint-open` evaluator reads as its
        // current_checkpoint. Its scope must not overlap the closed one above.
        status: 'open',
        artifact_id: ARTIFACT_ID,
        n: 2,
        declared_step_ids: [STEP_TWO],
        policy_exceptions: [],
        plan_revision_id: null,
        head_sha: HEAD_SHA,
      },
    ],
    // Which phase to run the evaluator at. Defaults to the evaluator's own
    // `phase` when omitted; `checkpoint_n` names the checkpoint above.
    fires_at: 'checkpoint-open',
    checkpoint_n: 2,
  };
}
