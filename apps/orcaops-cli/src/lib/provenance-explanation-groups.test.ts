import { expect, it } from 'vitest';

import { groupExplanations } from './provenance-explanation-groups.js';
import {
  type Explanation,
  explanationEvolution,
  explanationMentionsChange,
  type FocusedKnowledge,
} from './provenance-explanations.js';

function pair(): [Explanation, Explanation] {
  const source: Explanation = {
    id: 'source',
    kind: 'decision',
    form: 'recorded_capture',
    account: {
      wording: 'Keep a delivery lease.',
      reason: 'Avoid duplicate sends.',
      alternatives: [],
    },
    source: { artifact_id: 'artifact', event_id: 'event', field_path: 'decisions.0.decision' },
    relevance: { basis: 'candidate_event', target: { kind: 'candidate_context', terms: [] } },
    temporal: 'historical_body',
    authority: 'recorded_account',
    context: [],
    reference: 'capture-reference',
  };
  return [
    source,
    {
      ...structuredClone(source),
      id: 'interpretation',
      form: 'unapproved_interpretation',
      authority: 'unapproved_interpretation',
      source_account: { ...source.account!, reference: source.reference },
      reference: 'interpretation-reference',
    },
  ];
}

it('groups only exact-source interpretations and retains differences and expansion', () => {
  const [source, interpretation] = pair();
  interpretation.account!.reason = null;
  const [group] = groupExplanations([interpretation, source]);
  expect(group!.account!.reason).toBe('Avoid duplicate sends.');
  expect(group!.interpretations).toEqual([
    expect.objectContaining({
      id: interpretation.id,
      authority: 'unapproved_interpretation',
      account: interpretation.account,
      reference: interpretation.reference,
    }),
  ]);
  expect(group!.interpretations![0]).not.toHaveProperty('source_account');
  const [unrelated, other] = pair();
  other.source_account!.reference = 'different-capture';
  expect(groupExplanations([unrelated, other])).toHaveLength(2);
});

it('does not repeat an identical account or let an oversized variant hide its source', () => {
  const [source, interpretation] = pair();
  const originals = structuredClone([source, interpretation]);
  const [group] = groupExplanations([source, interpretation]);
  expect(group!.interpretations![0]).toMatchObject({
    account_from: source.id,
  });
  expect(group!.interpretations![0]).not.toHaveProperty('account');
  expect([source, interpretation]).toEqual(originals);
  const [readable, oversized] = pair();
  oversized.account!.reason = 'Do not ignore the qualification. '.repeat(400);
  expect(groupExplanations([readable, oversized])).toHaveLength(2);
  expect(readable.interpretations).toBeUndefined();
});

it('shares matching context but keeps disagreeing qualifications separate', () => {
  const [source, interpretation] = pair();
  const context: FocusedKnowledge = {
    id: 'decision:lease',
    kind: 'decision',
    placement: 'background',
    accounts: [],
    sources: [],
    reference: 'authority-reference',
    unresolved: [{ about: 'evidence', reason: 'evidence_not_attached', record_ids: [] }],
  };
  source.context = [context];
  interpretation.context = [structuredClone(context)];
  const [group] = groupExplanations([source, interpretation]);
  expect(group!.context).toHaveLength(1);
  expect(group!.interpretations![0]!.context_ids).toEqual([context.id]);
  const [conflicted, variant] = pair();
  conflicted.context = [context];
  variant.context = [
    {
      ...context,
      unresolved: [{ about: 'evidence', reason: 'evidence_not_attached', record_ids: ['missing'] }],
    },
  ];
  expect(groupExplanations([conflicted, variant])).toHaveLength(2);
});

it('groups change previews by actual source event without asserting equivalence or replacement', () => {
  const [source, interpretation] = pair();
  source.account!.wording = 'Replace the delivery lease with an outbox.';
  interpretation.account!.wording = 'Do not replace the delivery lease before recovery is tested.';
  interpretation.source_account = { ...source.account!, reference: source.reference };
  const separate = structuredClone(source);
  separate.id = 'other-account';
  separate.source.event_id = 'other-event';
  separate.reference = 'other-reference';
  const reading = { records: [], context: { entries: [] } } as unknown as Parameters<
    typeof explanationEvolution
  >[0];
  const groups = groupExplanations([source, interpretation, separate]);
  const evolution = explanationEvolution(reading, groups, []);
  expect(evolution).toHaveLength(2);
  expect(evolution[0]).toMatchObject({
    standing: 'recorded_wording_only',
    relationship: null,
    earlier: null,
    related_passages: [
      expect.objectContaining({
        authority: 'unapproved_interpretation',
        wording: expect.objectContaining({ text: interpretation.account!.wording }),
      }),
    ],
  });
  groups[0]!.account = { ...groups[0]!.account!, wording: 'Keep the delivery lease.' };
  expect(explanationMentionsChange(groups[0]!)).toBe(true);
});
