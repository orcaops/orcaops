import { describe, expect, it } from 'vitest';

import type { DatabaseJson } from '@orcaops/storage/history/database';

import { describeProcessingFailure } from './knowledge-processing-failure.js';

describe('why a job gave up', () => {
  it('names a spent allowance together with what its last attempt ended on', () => {
    expect(
      describeProcessingFailure(
        { outcome: 'attempts_exhausted', attempts: 3, max_attempts: 3 },
        { unit: { index: 0 }, call: { code: 'PROVIDER_FAILED', message: 'upstream 503' } }
      )
    ).toBe(
      'It spent its allowance of 3 attempt(s); on the last one the provider call failed with ' +
        'PROVIDER_FAILED: upstream 503.'
    );
    expect(
      describeProcessingFailure(
        { outcome: 'attempts_exhausted', attempts: 1, max_attempts: 1 },
        null
      )
    ).toBe('It spent its allowance of 1 attempt(s).');
  });

  it.each<[DatabaseJson, string]>([
    [
      { call: { code: 'INPUT_TOO_LARGE', message: 'too big' } },
      'the provider call failed with INPUT_TOO_LARGE: too big',
    ],
    [{ error: 'Unexpected token' }, 'the answer was not JSON: Unexpected token'],
    [
      { failures: [{ rule: 'MANIFEST_MISMATCH', detail: 'x' }, { rule: 'ITEM_SCHEMA_INVALID' }] },
      'the proposal was refused (MANIFEST_MISMATCH, ITEM_SCHEMA_INVALID)',
    ],
    [
      { source_preflight_refused: 'secret found' },
      "the store refused the unit's sources: secret found",
    ],
    [
      { publication_refused: { code: 'IDENTITY_TAKEN', detail: 'already published' } },
      'the store refused to publish the result (IDENTITY_TAKEN): already published',
    ],
  ])('names what ended the job: %j', (result, reason) => {
    expect(describeProcessingFailure(result, result)).toBe(`It gave up because ${reason}.`);
  });

  it('shows a result it does not recognize rather than inventing a reason', () => {
    expect(describeProcessingFailure({ something: 'else' }, null)).toBe(
      'It gave up with {"something":"else"}.'
    );
    expect(describeProcessingFailure(null, null)).toBe('It gave up without recording a reason.');
  });

  it('keeps a long provider message to one bounded line', () => {
    const text = describeProcessingFailure(
      { call: { code: 'INVALID_REQUEST', message: `line one\nline two ${'x'.repeat(1_000)}` } },
      null
    );
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(400);
  });
});
