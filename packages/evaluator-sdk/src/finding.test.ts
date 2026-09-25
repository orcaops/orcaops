import { describe, expect, it } from 'vitest';

import { EvaluatorFindingSchema } from '@orcaops/evaluator-protocol';

import {
  acceptanceCriterionLocation,
  fileLocation,
  finding,
  findingKey,
  planStepLocation,
} from './finding.js';

describe('finding', () => {
  it('omits every field the author did not supply', () => {
    expect(finding({ title: 'a statement' })).toEqual({ title: 'a statement' });
  });

  it('folds a multi-line title into one line the protocol accepts', () => {
    // A title built out of captured prose must not fail an author's run over
    // a newline in someone else's text.
    const built = finding({ title: '  first line\nsecond\r\nthird fourth  ' });
    expect(built.title).toBe('first line second third fourth');
    expect(EvaluatorFindingSchema.safeParse(built).success).toBe(true);
  });

  it('carries key, detail, locations and conclusion through unchanged', () => {
    const built = finding({
      key: 'criterion/c1',
      title: 'c1 is met',
      detail: 'the delivered tests cover it',
      locations: [acceptanceCriterionLocation('c1')],
      conclusion: 'supported',
    });
    expect(built).toEqual({
      key: 'criterion/c1',
      title: 'c1 is met',
      detail: 'the delivered tests cover it',
      locations: [{ kind: 'acceptance-criterion', criterion_id: 'c1' }],
      conclusion: 'supported',
    });
    expect(EvaluatorFindingSchema.safeParse(built).success).toBe(true);
  });
});

describe('locations', () => {
  it('builds each pointer kind the evaluator context can populate', () => {
    expect(planStepLocation('step-1')).toEqual({ kind: 'plan-step', step_id: 'step-1' });
    expect(acceptanceCriterionLocation('c1')).toEqual({
      kind: 'acceptance-criterion',
      criterion_id: 'c1',
    });
    expect(fileLocation('src/a.ts', { startLine: 4, endLine: 9 })).toEqual({
      kind: 'file',
      path: 'src/a.ts',
      start_line: 4,
      end_line: 9,
    });
  });

  it('normalises a path the protocol would refuse', () => {
    expect(fileLocation('./src/a.ts').path).toBe('src/a.ts');
    expect(fileLocation('src\\a.ts').path).toBe('src/a.ts');
    expect(fileLocation('/repo/src/a.ts', { repoRoot: '/repo' }).path).toBe('src/a.ts');
    expect(fileLocation('/repo/src/a.ts', { repoRoot: '/repo/' }).path).toBe('src/a.ts');
  });

  it('leaves a path outside the repository root alone, for the protocol to refuse', () => {
    // Rewriting it would name a different file. The schema says no, loudly, in
    // the author's own process.
    const location = fileLocation('/elsewhere/a.ts', { repoRoot: '/repo' });
    expect(location).toEqual({ kind: 'file', path: '/elsewhere/a.ts' });
    expect(EvaluatorFindingSchema.safeParse({ title: 't', locations: [location] }).success).toBe(
      false
    );
  });
});

describe('findingKey', () => {
  it('joins segments into a key', () => {
    expect(findingKey('removed', 'src/a.ts', 'parseThing')).toBe('removed/src/a.ts/parseThing');
  });

  it('returns nothing when the segments cannot spell a stable key', () => {
    // A file name with a space is ordinary; losing the key costs the finding
    // its cross-run identity, and losing the run would cost the author far
    // more. Nothing is sanitised: a key with characters removed would name
    // something the producer never named.
    expect(findingKey('removed', 'src/my file.ts')).toBeUndefined();
    expect(findingKey('removed', '/abs/a.ts')).toBeUndefined();
    expect(findingKey('removed', '../a.ts')).toBeUndefined();
    expect(findingKey('removed', 'src\\a.ts')).toBeUndefined();
    expect(findingKey('')).toBeUndefined();
  });

  it('produces keys the protocol accepts', () => {
    const key = findingKey('scope', 'payments');
    expect(EvaluatorFindingSchema.safeParse({ key, title: 't' }).success).toBe(true);
  });
});
