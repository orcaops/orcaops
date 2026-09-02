import { describe, expect, it } from 'vitest';

import { prePrCheckedOutcome, PrePrCheckedPayloadSchema } from './pre-pr-checked.js';

const timestamp = '2026-08-31T12:00:00.000Z';

describe('PrePrCheckedPayloadSchema', () => {
  it('reads historical markers as passing reviews', () => {
    const payload = PrePrCheckedPayloadSchema.parse({ head_sha: 'abc', ts: timestamp });
    expect(prePrCheckedOutcome(payload)).toBe('passed');
  });

  it('preserves the exact run set for a warning review', () => {
    const payload = PrePrCheckedPayloadSchema.parse({
      head_sha: 'abc',
      ts: timestamp,
      outcome: 'needs_attention',
      evaluator_set_fingerprint: 'a'.repeat(64),
      review_context_fingerprint: 'b'.repeat(64),
      run_ids: ['run-a', 'run-b'],
    });
    expect(payload.run_ids).toEqual(['run-a', 'run-b']);
    expect(prePrCheckedOutcome(payload)).toBe('needs_attention');
  });

  it('rejects a review record with only some binding fields', () => {
    expect(
      PrePrCheckedPayloadSchema.safeParse({
        head_sha: 'abc',
        ts: timestamp,
        outcome: 'passed',
      }).success
    ).toBe(false);
  });
});
