import { expect, it } from 'vitest';

import { groupExplanations } from './provenance-explanation-groups.js';
import {
  conciseExplanation,
  type Explanation,
  explanationChangeSupport,
  orderExplanations,
} from './provenance-explanations.js';

function explanation(id: string, artifact: string, basis: string): Explanation {
  return {
    id,
    kind: 'decision',
    form: 'recorded_capture',
    account: { wording: 'Preserve navigator history.', reason: 'Back restores the list.' },
    source: {
      artifact_id: artifact,
      event_id: `${artifact}:event`,
      field_path: 'decisions.0.decision',
    },
    relevance: { basis, target: { kind: 'candidate_context', terms: [] } },
    temporal: 'historical_body',
    authority: 'recorded_account',
    context: [],
    reference: id,
  };
}

it('rotates artifacts only within a discovery strength tier', () => {
  const direct = ['a', 'b', 'c'].map((id) => explanation(id, 'one', 'candidate_event'));
  const plan = explanation('d', 'two', 'candidate_plan');
  const lexical = Array.from({ length: 100 }, (_, i) => {
    const item = explanation(`lexical${i}`, `other${i}`, 'lexical_overlap');
    item.relevance.target = { kind: 'explicit_path', terms: ['src/navigation.ts'] };
    return item;
  });
  expect(
    orderExplanations([...lexical, plan, ...direct])
      .slice(0, 4)
      .map((item) => item.id)
  ).toEqual(['a', 'b', 'c', 'd']);
  const peer = explanation('e', 'two', 'candidate_event');
  expect(orderExplanations([...direct, peer]).map((item) => item.id)).toEqual(['a', 'e', 'b', 'c']);
});

it('uses the strongest independently observed discovery path without upgrading a lexical hop', () => {
  const plan = explanation('plan', 'one', 'candidate_plan');
  const indirect = explanation('indirect', 'two', 'source_reference');
  indirect.relevance.discovery = [
    { origin: 'lexical_overlap', event_id: 'other', via: 'source_reference' },
  ];
  expect(orderExplanations([indirect, plan]).map((item) => item.id)).toEqual(['plan', 'indirect']);
  indirect.relevance.discovery.push({
    origin: 'candidate_event',
    event_id: 'direct',
    via: 'source_reference',
  });
  expect(orderExplanations([plan, indirect]).map((item) => item.id)).toEqual(['indirect', 'plan']);
});

it('ranks specific decisions ahead of another candidate artifact summary', () => {
  const one = explanation('a', 'one', 'candidate_event');
  const two = explanation('b', 'one', 'candidate_event');
  const summary = explanation('c', 'two', 'candidate_event');
  summary.kind = 'context';
  summary.account!.reason = null;
  expect(orderExplanations([summary, one, two]).map((item) => item.id)).toEqual(['a', 'b', 'c']);
});

it('requires the change passage itself to connect to the rationale', () => {
  const seeds = ['Keep durable delivery leases so notification retries survive worker crashes.'];
  const mixed = explanation('mixed', 'one', 'lexical_overlap');
  mixed.kind = 'context';
  mixed.account = {
    wording:
      'Durable delivery leases now survive notification retries. Removed the screenshot directory and regenerated build manifests.',
    reason: null,
  };
  expect(explanationChangeSupport(mixed, seeds)).toBe(false);
  mixed.account.wording =
    'Replace durable delivery leases with a transactional notification outbox.';
  expect(explanationChangeSupport(mixed, seeds)).toBe(true);
  mixed.account.wording =
    'Do not replace durable delivery leases until recovery has been exercised.';
  expect(explanationChangeSupport(mixed, seeds)).toBe(true);
});

it('uses account context recovery only for ordinary qualifications', () => {
  const item = explanation('account', 'one', 'candidate_event');
  item.context = [
    {
      id: 'decision:one',
      kind: 'decision',
      placement: 'background',
      reference: 'authority-token',
      accounts: [
        { revision_id: 'revision', standing: 'not_standing', applicability: 'applies', scopes: [] },
      ],
      unresolved: [{ about: 'evidence', reason: 'evidence_not_attached', record_ids: [] }],
    },
  ];
  const concise = conciseExplanation(item);
  expect(concise.reference).toBe(item.reference);
  expect(concise.context[0]?.reference).toBeNull();
  expect(concise.context[0]?.qualification).toMatchObject({
    revision_id: 'revision',
    standing: 'not_standing',
    applicability: 'applies',
  });
  expect(concise.context[0]?.unresolved).toEqual(item.context[0]!.unresolved);
  item.context[0]!.limitations = [
    { record: 'relationship', record_id: 'replacement', reason: 'another_scope' },
  ];
  expect(conciseExplanation(item).context[0]?.reference).toBe('authority-token');
});

it('keeps differently qualified wording and reasons rather than collapsing them into the source', () => {
  const item = explanation('account', 'one', 'candidate_event');
  item.context = [
    {
      id: 'decision:one',
      kind: 'decision',
      placement: 'background',
      reference: 'context-token',
      accounts: [
        {
          revision_id: 'revision',
          statement: item.account!.wording,
          reason: item.account!.reason,
          standing: 'not_standing',
          applicability: 'applies',
          scopes: [],
        },
      ],
    },
  ];
  const original = structuredClone(item);
  const concise = conciseExplanation(item);
  expect(concise.context[0]?.qualification?.wording_from).toBe(item.id);
  expect(concise.context[0]?.qualification?.reason_from).toBe(item.id);
  expect(item).toEqual(original);
  item.context[0]!.accounts[0]!.reason = 'Do not apply this design to restored sessions.';
  expect(conciseExplanation(item).context).toEqual(item.context);
  item.context[0]!.accounts[0]!.reason = item.account!.reason;
  item.context[0]!.accounts[0]!.statement = 'Do not preserve history across accounts.';
  expect(conciseExplanation(item).context).toEqual(item.context);
});

it.each(['navigation', 'delivery'])(
  'connects differently worded decisions through a recorded identity for %s',
  (domain) => {
    const central = explanation('central', 'one', 'candidate_event');
    central.account = {
      wording: 'Keep destination meaning separate from platform actions.',
      reason: 'The platforms have incompatible lifecycles.',
    };
    central.context = [
      { id: 'decision:shared', accounts: [] } as unknown as Explanation['context'][number],
    ];
    const summary = explanation('summary', 'one', 'candidate_event');
    summary.kind = 'context';
    summary.account = { wording: `${domain} delegates actions to the platform.`, reason: null };
    summary.context = central.context;
    summary.relevance.target = { kind: 'target_terms', terms: [domain] };
    const noise = Array.from({ length: 100 }, (_, index) => {
      const item = explanation(`noise${index}`, `other${index}`, 'candidate_event');
      item.account = { wording: 'Preserve the client contract.', reason: 'Retain existing names.' };
      item.relevance.target = { kind: 'target_terms', terms: ['client', 'contract'] };
      return item;
    });
    const ordered = orderExplanations(
      [...noise, central, summary],
      `packages/client/src/${domain}.ts`
    );
    expect(ordered[0]?.id).toBe('central');
    expect(ordered[0]?.relevance).toEqual({
      ...central.relevance,
      support: {
        account_id: 'summary',
        knowledge_id: 'decision:shared',
        target: summary.relevance.target,
      },
    });
    expect(ordered[0]?.authority).toBe('recorded_account');
    expect(central.relevance.support).toBeUndefined();

    for (const change of ['lexical', 'interpretation', 'unrelated'] as const) {
      const changed = structuredClone(summary);
      if (change === 'lexical') changed.relevance.basis = 'lexical_overlap';
      if (change === 'interpretation') changed.form = 'unapproved_interpretation';
      if (change === 'unrelated') changed.context[0]!.id = 'decision:other';
      expect(
        orderExplanations([central, changed], `src/${domain}.ts`).find(
          (item) => item.id === 'central'
        )?.relevance.support
      ).toBeUndefined();
    }
    const lexical = { ...central, relevance: { ...central.relevance, basis: 'lexical_overlap' } };
    expect(
      orderExplanations([lexical, summary], `src/${domain}.ts`).find(
        (item) => item.id === 'central'
      )?.relevance.support
    ).toBeUndefined();
  }
);

it('does not propagate shared identity support transitively', () => {
  const first = explanation('first', 'one', 'candidate_event');
  const bridge = explanation('bridge', 'one', 'candidate_event');
  const last = explanation('last', 'one', 'candidate_event');
  const context = (id: string) =>
    ({ id, accounts: [] }) as unknown as Explanation['context'][number];
  first.account!.wording = 'The delivery queue owns retries.';
  first.relevance.target = { kind: 'target_terms', terms: ['delivery'] };
  first.context = [context('first')];
  bridge.context = [context('first'), context('last')];
  last.context = [context('last')];
  const ordered = orderExplanations([first, bridge, last], 'src/delivery.ts');
  expect(ordered.find((item) => item.id === 'bridge')?.relevance.support).toBeDefined();
  expect(ordered.find((item) => item.id === 'last')?.relevance.support).toBeUndefined();
});

it('does not borrow identity connections added only by grouped interpretations', () => {
  const original = explanation('original', 'one', 'candidate_event');
  const summary = explanation('summary', 'one', 'candidate_event');
  summary.account!.wording = 'Keep delivery leases durable.';
  summary.relevance.target = { kind: 'target_terms', terms: ['delivery'] };
  summary.context = [
    { id: 'interpreted-only', accounts: [] } as unknown as Explanation['context'][number],
  ];
  const interpretation = explanation('variant', 'one', 'candidate_event');
  interpretation.form = 'unapproved_interpretation';
  interpretation.source_account = { ...original.account!, reference: original.reference };
  interpretation.context = summary.context;
  const accounts = [original, interpretation, summary];
  const grouped = groupExplanations(accounts);
  expect(grouped.find((item) => item.id === original.id)?.context).toEqual(summary.context);
  expect(original.context).toEqual([]);
  expect(
    orderExplanations(grouped, 'src/delivery.ts', accounts).find((item) => item.id === 'original')
      ?.relevance.support
  ).toBeUndefined();
});

it('rotates artifacts only after target strength and explanation purpose', () => {
  const direct = ['a', 'b', 'c'].map((id) => {
    const item = explanation(id, 'one', 'candidate_event');
    item.account!.wording = 'Keep src/delivery.ts as the durable queue owner.';
    item.relevance.target = { kind: 'explicit_path', terms: ['src/delivery.ts'] };
    return item;
  });
  const weak = explanation('other', 'two', 'candidate_event');
  expect(orderExplanations([weak, ...direct], 'src/delivery.ts').map((item) => item.id)).toEqual([
    'a',
    'b',
    'c',
    'other',
  ]);
});
