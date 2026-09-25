import { describe, expect, it } from 'vitest';

import { INSTRUCTIONS_SHA256, RESPONSE_INSTRUCTIONS, SYSTEM_PROMPT } from './instructions.js';

describe('interpretation instructions', () => {
  it('asks for segment quotations without provider-authored offsets', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('{source_ref,segment_ref,quote}');
    expect(RESPONSE_INSTRUCTIONS).toContain('Never provide byte offsets');
  });

  it('distinguishes exact repetition, proposed equivalence and unknown rationale', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('exact_restatement');
    expect(RESPONSE_INSTRUCTIONS).toContain('equivalent_to');
    expect(RESPONSE_INSTRUCTIONS).toContain('rationale {kind:"unknown"}');
  });

  it('requires separate evidence for rejected choices and their stated reasons', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('Only a decision may have nonempty alternatives');
    expect(RESPONSE_INSTRUCTIONS).toContain('{option,option_citations,');
    expect(RESPONSE_INSTRUCTIONS).toContain('rejected_because,rejection_citations}');
    expect(RESPONSE_INSTRUCTIONS).toContain('attached to the decision that rejected');
    expect(RESPONSE_INSTRUCTIONS).toContain('Do not invent');
    expect(RESPONSE_INSTRUCTIONS).toContain('a missing reason');
    expect(RESPONSE_INSTRUCTIONS).toContain('An alternative is not the chosen decision');
  });

  it('defines provider scope without asking the model for a task identifier', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'intended_scope   {kind:"project"}, {kind:"current_task"}, or {kind:"unknown"}'
    );
    expect(RESPONSE_INSTRUCTIONS).toContain('Deterministic code supplies the task ID');
    expect(RESPONSE_INSTRUCTIONS).not.toContain('{kind:"artifact",artifact_id}');
  });

  it('documents semantic distinctions for durable knowledge candidates', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('including requirements, decisions and factual claims');
    expect(RESPONSE_INSTRUCTIONS).toContain('Ordinary instructions to read, inspect');
    expect(RESPONSE_INSTRUCTIONS).toContain('task_local_criterion with');
    expect(RESPONSE_INSTRUCTIONS).toContain('proposed_record none unless');
    expect(RESPONSE_INSTRUCTIONS).toContain('is not independently a');
    expect(RESPONSE_INSTRUCTIONS).toContain('Omit redundant commentary');
  });

  it('requires a corrected fact only for factual corrections', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'A factual_correction account quote must state the corrected fact'
    );
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'A challenge needs exact evidence for the concern but need not supply or invent a'
    );
  });

  it('requires exact punctuation rather than repaired quotations', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'Keep punctuation, capitalization and spacing unchanged'
    );
    expect(RESPONSE_INSTRUCTIONS).toContain('Do not replace a trailing comma with a period');
  });

  it('distinguishes continuing requirements from deliverables and unimplemented promises', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('Writing a document about a lasting system');
    expect(RESPONSE_INSTRUCTIONS).toContain('uncertainty or open item can state a firm');
    expect(RESPONSE_INSTRUCTIONS).toContain('continuing requirement and unfinished implementation');
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'not implemented, not tested, or inferred from documentation'
    );
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'If supplied passages conflict, report that uncertainty'
    );
    expect(RESPONSE_INSTRUCTIONS).toContain('until a named condition changes');
  });

  it('separates identity matches from factual support and approval', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('must target the same record kind');
    expect(RESPONSE_INSTRUCTIONS).toContain('never a claim. exact_restatement');
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'independently supported statement with no identity link'
    );
    expect(RESPONSE_INSTRUCTIONS).toContain('not a merge, replacement or approval');
  });

  it('asks for self-contained claims without merging separate occurrences by count', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('Make wording self-contained');
    expect(RESPONSE_INSTRUCTIONS).toContain('one statement with the supporting citations');
    expect(RESPONSE_INSTRUCTIONS).toContain('Equal test counts or similar wording alone do not');
  });

  it('describes retained interpretation scope as fallible context', () => {
    expect(RESPONSE_INSTRUCTIONS).toContain('record integrity and target linkage only');
    expect(RESPONSE_INSTRUCTIONS).toContain('fallible model interpretation');
    expect(RESPONSE_INSTRUCTIONS).toContain('do not assume omitted conditions are satisfied');
    expect(RESPONSE_INSTRUCTIONS).toContain(
      'A legacy or non-model record with no retained interpretation has no model'
    );
  });

  it.each([
    'must versus should',
    'subject',
    'conditions',
    'exceptions',
    'timing',
    'negation',
    'intended scope',
  ])('requires equivalence checks for %s', (dimension) =>
    expect(RESPONSE_INSTRUCTIONS).toContain(dimension)
  );

  it.each(['rejected_alternative', 'rejection_reason', 'non_goal', 'non_goal_reason'])(
    'keeps %s out of chosen obligations and decisions',
    (role) => expect(RESPONSE_INSTRUCTIONS).toContain(role)
  );

  it('states that detector output carries no authority and hashes the wording', () => {
    expect(SYSTEM_PROMPT).toContain('authorize nothing');
    expect(INSTRUCTIONS_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
